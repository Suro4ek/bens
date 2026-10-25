import type { KubeObject } from "./api";

/** A ConfigMap or Secret a container takes variables from. */
export interface EnvSource {
  kind: "ConfigMap" | "Secret";
  name: string;
}

/** What reading a source gave: its data (a Secret's decoded), that it doesn't exist, or why it couldn't be read. */
export type SourceData = { data: Record<string, string> } | { missing: true } | { error: string };

export interface EnvVar {
  name: string;
  /** The value, when known: a literal, a field of the pod, or a key of a source that was read. */
  value?: string;
  /** The source key of a `configMapKeyRef` / `secretKeyRef`. */
  ref?: EnvSource & { key: string; optional?: boolean };
  /** The pod field (`fieldRef`) or container resource (`resourceFieldRef`) it is set to. */
  field?: string;
  /** From a Secret: hidden until asked for. */
  secret?: boolean;
  /** Why there is no value: the source or the key doesn't exist, or the source couldn't be read. */
  problem?: string;
  /** A later variable of the same name replaces it (`envFrom` is applied first, then `env`, in order). */
  overridden?: boolean;
}

export interface EnvGroup {
  /** The source of an `envFrom` entry; none for the container's own `env`. */
  from?: EnvSource & { prefix?: string; optional?: boolean; problem?: string; loading?: boolean };
  vars: EnvVar[];
}

export const sourceId = (s: EnvSource) => `${s.kind}/${s.name}`;

const keyRef = (from: any): EnvVar["ref"] => {
  const r = from?.configMapKeyRef ?? from?.secretKeyRef;
  return r && { kind: from.configMapKeyRef ? "ConfigMap" : "Secret", name: r.name, key: r.key, optional: r.optional };
};

const fromRef = (f: any): EnvGroup["from"] => {
  const r = f?.configMapRef ?? f?.secretRef;
  return r && { kind: f.configMapRef ? "ConfigMap" : "Secret", name: r.name, prefix: f.prefix, optional: r.optional };
};

/** The ConfigMaps and Secrets the pod's containers take variables from, each once. */
export function envSources(pod: KubeObject): EnvSource[] {
  const containers = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])] as any[];
  const refs = containers.flatMap((c) => [...((c.env ?? []) as any[]).map((e) => keyRef(e.valueFrom)), ...((c.envFrom ?? []) as any[]).map(fromRef)]);
  const unique = new Map<string, EnvSource>();
  for (const r of refs) if (r) unique.set(sourceId(r), { kind: r.kind, name: r.name });
  return [...unique.values()];
}

/** The value of a `fieldRef` path on the pod: `metadata.name`, `metadata.labels['app']`, `status.podIP`… */
export function podField(pod: KubeObject, path: string): string | undefined {
  const m = /^metadata\.(labels|annotations)\['(.*)'\]$/.exec(path);
  if (m) return pod.metadata[m[1] as "labels" | "annotations"]?.[m[2]];
  let v: any = pod;
  for (const part of path.split(".")) v = v?.[part];
  if (Array.isArray(v)) return v.map((x) => x?.ip ?? x).join(","); // status.podIPs, status.hostIPs
  return v === undefined || v === null || typeof v === "object" ? undefined : String(v);
}

/** A container's environment: its `env` first, then one group per `envFrom` entry. */
export function containerEnv(pod: KubeObject, c: any, sources: Record<string, SourceData | undefined>): EnvGroup[] {
  const env = ((c.env ?? []) as any[]).map((e): EnvVar => {
    const from = e.valueFrom;
    if (!from) return { name: e.name, value: e.value ?? "" };
    const ref = keyRef(from);
    if (ref) {
      const v: EnvVar = { name: e.name, ref, secret: ref.kind === "Secret" };
      const got = sources[sourceId(ref)];
      if (!got) return v;
      if ("error" in got) return { ...v, problem: got.error };
      if ("missing" in got) return { ...v, problem: `${ref.kind} not found` };
      return ref.key in got.data ? { ...v, value: got.data[ref.key] } : { ...v, problem: "key not found" };
    }
    if (from.fieldRef) return { name: e.name, field: from.fieldRef.fieldPath, value: podField(pod, from.fieldRef.fieldPath) };
    const res = from.resourceFieldRef;
    if (res) return { name: e.name, field: res.containerName ? `${res.containerName}: ${res.resource}` : res.resource };
    return { name: e.name, field: Object.keys(from)[0] };
  });

  const groups = ((c.envFrom ?? []) as any[]).flatMap((f): EnvGroup[] => {
    const from = fromRef(f);
    if (!from) return [];
    const got = sources[sourceId(from)];
    if (!got) return [{ from: { ...from, loading: true }, vars: [] }];
    if ("error" in got) return [{ from: { ...from, problem: got.error }, vars: [] }];
    if ("missing" in got) return [{ from: { ...from, problem: `${from.kind} not found` }, vars: [] }];
    const secret = from.kind === "Secret";
    return [{ from, vars: Object.entries(got.data).map(([key, value]) => ({ name: (from.prefix ?? "") + key, value, secret })) }];
  });

  // The kubelet sets envFrom first and env after it, each in order: the last of a name wins.
  // Variables it skips (missing optional keys) replace nothing.
  const applied = [...groups.flatMap((g) => g.vars), ...env].filter((v) => !v.problem);
  const last = new Map(applied.map((v) => [v.name, v]));
  for (const v of applied) if (last.get(v.name) !== v) v.overridden = true;

  return [{ vars: env }, ...groups];
}
