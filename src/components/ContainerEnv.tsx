import { useEffect, useState } from "react";
import { ChevronsUpDown, Eye, EyeOff } from "lucide-react";
import type { KubeObject, ResourceInfo } from "../api";
import { useApi } from "../clusterContext";
import { containerEnv, EnvSource, envSources, EnvVar, SourceData, sourceId } from "../env";
import { navId } from "../nav";
import { decodeB64 } from "../util";

type Navigate = (navId: string, uid?: string, ref?: { namespace?: string; name: string }) => void;
export type EnvSources = Record<string, SourceData | undefined>;

const VIEW: Record<EnvSource["kind"], string> = { ConfigMap: "/configmaps", Secret: "/secrets" };

/** Reads the ConfigMaps and Secrets the pod's containers take variables from, once for the whole pod. */
export function useEnvSources(pod: KubeObject, resources: ResourceInfo[]): EnvSources {
  const api = useApi();
  const namespace = pod.metadata.namespace;
  const sources = envSources(pod);
  const ids = sources.map(sourceId).join("\n");
  const [read, setRead] = useState<EnvSources>({});
  useEffect(() => {
    let live = true;
    setRead({});
    for (const s of sources) {
      const key = resources.find((r) => navId(r) === VIEW[s.kind])?.key;
      if (!key) continue;
      api.getObject(key, namespace, s.name).then(
        (o) => {
          const raw: Record<string, string> = o?.data ?? {};
          const data = s.kind === "Secret" ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeB64(v)])) : raw;
          if (live) setRead((r) => ({ ...r, [sourceId(s)]: o ? { data } : { missing: true } }));
        },
        (e) => live && setRead((r) => ({ ...r, [sourceId(s)]: { error: String(e) } })),
      );
    }
    return () => {
      live = false;
    };
    // `ids` stands for `sources`, which is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, namespace, ids]);
  return read;
}

/** A container's `env` and `envFrom`; values come from its ConfigMaps and Secrets, Secret values stay hidden until shown. */
export function ContainerEnv({ pod, c, sources, onNavigate }: { pod: KubeObject; c: any; sources: EnvSources; onNavigate: Navigate }) {
  const entries = (c.env ?? []).length + (c.envFrom ?? []).length;
  const [open, setOpen] = useState(entries <= 10);
  const [shown, setShown] = useState<Set<string>>(new Set());
  if (!entries) return null;

  const groups = containerEnv(pod, c, sources);
  const total = groups.reduce((n, g) => n + g.vars.length, 0);
  const toggle = (id: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const link = (s: EnvSource) => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onNavigate(VIEW[s.kind], undefined, { namespace: pod.metadata.namespace, name: s.name });
      }}
    >
      {s.name}
    </a>
  );
  const eye = (id: string, hidden: boolean) => (
    <button className="icon env-eye" title={hidden ? "Show" : "Hide"} onClick={() => toggle(id)}>
      {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
    </button>
  );
  const variable = (v: EnvVar, key: string, hidden: boolean, eyeId?: string) => (
    <div key={key} className={`env-var${v.overridden ? " overridden" : ""}`} title={v.overridden ? "Replaced by a later variable of the same name" : undefined}>
      <span className="env-name">{v.name}</span>
      {": "}
      {v.value !== undefined ? (
        <span className="env-value">{hidden ? "••••••••" : v.value}</span>
      ) : v.problem ? (
        <span className={`small ${v.ref?.optional ? "muted" : "env-problem"}`}>{v.problem}</span>
      ) : (
        !v.field && <span className="muted">…</span>
      )}
      {eyeId && v.value !== undefined && eye(eyeId, hidden)}
      {v.ref && (
        <span className="muted small">
          {" "}
          ({v.ref.optional && "optional "}key {v.ref.key} of {v.ref.kind} {link(v.ref)})
        </span>
      )}
      {v.field && <span className="muted small"> ({v.field})</span>}
    </div>
  );

  return (
    <>
      <dt className={entries > 1 ? "toggle-dt" : ""} onClick={() => entries > 1 && setOpen((o) => !o)}>
        Environment {entries > 1 && <ChevronsUpDown size={12} />}
      </dt>
      <dd>
        {!open ? (
          <span className="link-text" onClick={() => setOpen(true)}>
            {total} {total === 1 ? "variable" : "variables"}
          </span>
        ) : (
          groups.map(({ from, vars }, g) => {
            if (!from) return vars.map((v, i) => variable(v, `env:${i}`, !!v.secret && !shown.has(`env:${i}`), v.secret ? `env:${i}` : undefined));
            const id = `from:${g}`;
            const hidden = from.kind === "Secret" && !shown.has(id);
            return (
              <div key={id} className="env-from">
                <div className="env-from-head muted small">
                  All keys of {from.kind} {link(from)}
                  {from.prefix && (
                    <>
                      {" "}
                      with prefix <span className="mono">{from.prefix}</span>
                    </>
                  )}
                  {from.optional && " (optional)"}
                  {from.kind === "Secret" && vars.length > 0 && eye(id, hidden)}
                </div>
                {from.problem && <div className={`small ${from.optional ? "muted" : "env-problem"}`}>{from.problem}</div>}
                {from.loading && <div className="muted">…</div>}
                {!from.problem && !from.loading && !vars.length && <div className="muted small">No keys</div>}
                {vars.map((v, i) => variable(v, `${id}:${i}`, hidden))}
              </div>
            );
          })
        )}
      </dd>
    </>
  );
}
