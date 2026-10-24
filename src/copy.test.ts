import { describe, expect, it, vi } from "vitest";
import type { ClusterApi, KubeObject } from "./api";
import { cleanForCopy, copyObjects, copyProblem } from "./copy";

const secret = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  apiVersion: "v1",
  kind: "Secret",
  type: "Opaque",
  metadata: {
    name,
    namespace: "payments",
    uid: "uid-1",
    resourceVersion: "123",
    creationTimestamp: "2026-01-01T00:00:00Z",
    labels: { app: "api" },
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{…}", team: "core" },
    ownerReferences: [{ apiVersion: "v1", kind: "Foo", name: "x", uid: "u" }],
  },
  data: { TOKEN: "czNjcjN0" },
  ...extra,
});

/** A target cluster that remembers what it was asked to create or replace. */
function fakeTarget(existing: string[] = []) {
  const created: KubeObject[] = [];
  const replaced: KubeObject[] = [];
  const api = {
    cluster: "target",
    create: vi.fn(async (key: string, _ns: string | undefined, o: any) => {
      if (key.endsWith("/namespaces")) throw new Error("Namespace payments already exists");
      if (existing.includes(o.metadata.name)) throw new Error(`Secret ${o.metadata.name} already exists`);
      created.push(o);
      return o;
    }),
    put: vi.fn(async (_key: string, _ns: string | undefined, o: any) => {
      if (existing.includes(o.metadata.name)) {
        replaced.push(o);
        return false;
      }
      created.push(o);
      return true;
    }),
  } as unknown as ClusterApi;
  return { api, created, replaced };
}

describe("cleanForCopy", () => {
  it("keeps what the object holds and drops the source's identity", () => {
    expect(cleanForCopy(secret("api"), "prod")).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: "api", namespace: "prod", labels: { app: "api" }, annotations: { team: "core" } },
      data: { TOKEN: "czNjcjN0" },
    });
  });

  it("can rename, and keeps ConfigMap binaryData and immutability", () => {
    const cm: KubeObject = { kind: "ConfigMap", metadata: { name: "c" }, data: { a: "1" }, binaryData: { b: "AA==" }, immutable: true };
    expect(cleanForCopy(cm, "ns", "c2")).toEqual({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "c2", namespace: "ns" },
      data: { a: "1" },
      binaryData: { b: "AA==" },
      immutable: true,
    });
  });
});

describe("copyObjects", () => {
  const base = { key: "/v1/secrets", namespacesKey: "/v1/namespaces", namespace: "prod", createNamespace: true };

  it("creates copies and the namespace, without overwriting existing ones", async () => {
    const t = fakeTarget(["taken"]);
    const res = await copyObjects({ ...base, target: t.api, objects: [secret("api"), secret("taken")], overwrite: false });
    expect(res.map((r) => [r.name, r.outcome])).toEqual([
      ["api", "created"],
      ["taken", "exists"],
    ]);
    expect(t.created.map((o) => o.metadata.namespace)).toEqual(["prod"]);
    expect(t.api.create).toHaveBeenCalledWith("/v1/namespaces", undefined, expect.objectContaining({ kind: "Namespace" }));
  });

  it("replaces existing ones when asked to", async () => {
    const t = fakeTarget(["taken"]);
    const res = await copyObjects({ ...base, target: t.api, objects: [secret("taken")], overwrite: true });
    expect(res).toEqual([{ name: "taken", outcome: "replaced" }]);
    expect(t.replaced[0].data).toEqual({ TOKEN: "czNjcjN0" });
  });

  it("renames a single object", async () => {
    const t = fakeTarget();
    await copyObjects({ ...base, target: t.api, objects: [secret("api")], rename: "api-copy", overwrite: false });
    expect(t.created[0].metadata.name).toBe("api-copy");
  });

  it("skips service account tokens and Helm release state", async () => {
    const t = fakeTarget();
    const token = secret("sa-token", { type: "kubernetes.io/service-account-token" });
    const helm = secret("sh.helm.release.v1.app.v3", { type: "helm.sh/release.v1" });
    expect(copyProblem(token)).toBeTruthy();
    const res = await copyObjects({ ...base, target: t.api, objects: [token, helm, secret("ok")], overwrite: false });
    expect(res.map((r) => r.outcome)).toEqual(["skipped", "skipped", "created"]);
    expect(t.created.map((o) => o.metadata.name)).toEqual(["ok"]);
  });
});
