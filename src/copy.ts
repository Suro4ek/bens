//! Copying Secrets and ConfigMaps to another cluster or namespace.

import type { ClusterApi, KubeObject } from "./api";

export const COPYABLE = new Set(["/secrets", "/configmaps"]);

/** Annotations that describe the source object, not what it holds. */
const DROPPED_ANNOTATIONS = ["kubectl.kubernetes.io/last-applied-configuration"];

/** Why an object should not be copied, if it shouldn't. */
export function copyProblem(obj: KubeObject): string | undefined {
  if (obj.type === "kubernetes.io/service-account-token") return "a service account token only works in its own cluster";
  if (typeof obj.type === "string" && obj.type.startsWith("helm.sh/release")) return "Helm keeps its release state in it";
  return undefined;
}

/**
 * The object as it should be created elsewhere: what it holds (data, type,
 * labels, annotations), without the source's identity (uid, resource
 * version, owners, timestamps) or status.
 */
export function cleanForCopy(obj: KubeObject, namespace: string, name = obj.metadata.name): KubeObject {
  const { labels, annotations } = obj.metadata;
  const kept = Object.fromEntries(Object.entries(annotations ?? {}).filter(([k]) => !DROPPED_ANNOTATIONS.includes(k)));
  const copy: KubeObject = {
    apiVersion: obj.apiVersion ?? "v1",
    kind: obj.kind,
    metadata: {
      name,
      namespace,
      ...(labels && Object.keys(labels).length ? { labels } : {}),
      ...(Object.keys(kept).length ? { annotations: kept } : {}),
    },
  };
  for (const field of ["type", "data", "stringData", "binaryData", "immutable"]) {
    if (obj[field] !== undefined) copy[field] = obj[field];
  }
  return copy;
}

export interface CopyResult {
  name: string;
  outcome: "created" | "replaced" | "exists" | "skipped" | "failed";
  message?: string;
}

/** Copies objects of one type into a namespace of a cluster (which may be the source cluster). */
export async function copyObjects({
  target,
  key,
  namespacesKey,
  namespace,
  objects,
  rename,
  overwrite,
  createNamespace,
}: {
  target: ClusterApi;
  /** Resource key of the type in the target cluster. */
  key: string;
  namespacesKey?: string;
  namespace: string;
  objects: KubeObject[];
  /** New name, for a single object. */
  rename?: string;
  overwrite: boolean;
  createNamespace: boolean;
}): Promise<CopyResult[]> {
  if (createNamespace && namespacesKey) {
    // "Already exists" is the usual answer, and fine.
    await target.create(namespacesKey, undefined, { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } }).catch(() => {});
  }
  const results: CopyResult[] = [];
  for (const obj of objects) {
    const name = (objects.length === 1 && rename) || obj.metadata.name;
    const problem = copyProblem(obj);
    if (problem) {
      results.push({ name, outcome: "skipped", message: problem });
      continue;
    }
    const copy = cleanForCopy(obj, namespace, name);
    try {
      if (overwrite) results.push({ name, outcome: (await target.put(key, namespace, copy)) ? "created" : "replaced" });
      else {
        await target.create(key, namespace, copy);
        results.push({ name, outcome: "created" });
      }
    } catch (e) {
      const message = String(e);
      results.push({ name, outcome: /already exists/i.test(message) ? "exists" : "failed", message });
    }
  }
  return results;
}
