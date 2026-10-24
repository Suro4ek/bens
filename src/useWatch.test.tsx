import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { api, ContextInfo } from "./api";
import { ClusterContext } from "./clusterContext";
import { handlers, liveWatches, obj } from "./test/tauriMock";
import { useWatch } from "./useWatch";

const ctx = (name: string): ContextInfo => ({
  id: `/kube/config#${name}`,
  name,
  file: "/kube/config",
  pasted: false,
  cluster: name,
  user: "me",
});
const A = ctx("cluster-a");
const B = ctx("cluster-b");

const inCluster = (cluster: string) => ({ children }: { children: ReactNode }) => (
  <ClusterContext.Provider value={cluster}>{children}</ClusterContext.Provider>
);
const watchIn = (cluster: string, key: string, namespace: string | null = null) =>
  renderHook(() => useWatch(key, namespace), { wrapper: inCluster(cluster) });

const names = (items: { metadata: { name: string } }[]) => items.map((o) => o.metadata.name).sort();

describe("useWatch", () => {
  beforeEach(() => {
    handlers.connect = ({ context }: { context: string }) => ({
      context,
      serverVersion: "v1.33",
      defaultNamespace: "default",
      metrics: false,
      resources: [],
    });
  });

  it("applies the initial list and later changes", async () => {
    const { result } = watchIn(A.id, "/v1/namespaces");
    await waitFor(() => expect(liveWatches("/v1/namespaces", A.id)).toHaveLength(1));
    const [w] = liveWatches("/v1/namespaces", A.id);

    act(() => w.channel.send({ type: "reset", items: [obj("default"), obj("kube-system")] }));
    await waitFor(() => expect(names(result.current.items)).toEqual(["default", "kube-system"]));
    expect(result.current.loading).toBe(false);

    act(() => w.channel.send({ type: "apply", object: obj("payments") }));
    act(() => w.channel.send({ type: "delete", object: obj("default") }));
    await waitFor(() => expect(names(result.current.items)).toEqual(["kube-system", "payments"]));
  });

  it("watches the same resource in two clusters independently", async () => {
    const a = watchIn(A.id, "/v1/namespaces");
    const b = watchIn(B.id, "/v1/namespaces");
    await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(2));

    act(() => liveWatches("/v1/namespaces", A.id)[0].channel.send({ type: "reset", items: [obj("a-only")] }));
    act(() => liveWatches("/v1/namespaces", B.id)[0].channel.send({ type: "reset", items: [obj("b-only")] }));

    await waitFor(() => expect(names(a.result.current.items)).toEqual(["a-only"]));
    await waitFor(() => expect(names(b.result.current.items)).toEqual(["b-only"]));
  });

  // Reconnecting drops the cluster's backend streams: its lists must subscribe again,
  // and must not keep showing what they had before.
  it("re-subscribes after its cluster reconnects, leaving other clusters alone", async () => {
    const a = watchIn(A.id, "/v1/pods", "default");
    watchIn(B.id, "/v1/pods", "default");
    await waitFor(() => expect(liveWatches("/v1/pods")).toHaveLength(2));
    const firstA = liveWatches("/v1/pods", A.id)[0];
    const firstB = liveWatches("/v1/pods", B.id)[0];
    act(() => firstA.channel.send({ type: "reset", items: [obj("old-pod")] }));
    await waitFor(() => expect(names(a.result.current.items)).toEqual(["old-pod"]));

    await act(() => api.connect(A).then(() => {}));

    await waitFor(() => expect(liveWatches("/v1/pods", A.id)).toHaveLength(1));
    expect(liveWatches("/v1/pods", A.id)[0]).not.toBe(firstA);
    expect(a.result.current.items).toEqual([]);
    expect(liveWatches("/v1/pods", B.id)[0]).toBe(firstB);
  });

  it("stops watching on unmount", async () => {
    const { unmount } = watchIn(A.id, "/v1/nodes");
    await waitFor(() => expect(liveWatches("/v1/nodes")).toHaveLength(1));
    unmount();
    await waitFor(() => expect(liveWatches("/v1/nodes")).toHaveLength(0));
  });

  it("does nothing without a key", async () => {
    const { result } = renderHook(() => useWatch(undefined, null), { wrapper: inCluster(A.id) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([]);
  });
});
