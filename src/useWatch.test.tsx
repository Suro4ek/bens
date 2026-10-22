import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, ContextInfo } from "./api";
import { handlers, liveWatches, obj, resetMock } from "./test/tauriMock";
import { useWatch } from "./useWatch";

const ctx = (name: string): ContextInfo => ({
  id: `/kube/config#${name}`,
  name,
  file: "/kube/config",
  pasted: false,
  cluster: name,
  user: "me",
});

const names = (items: { metadata: { name: string } }[]) => items.map((o) => o.metadata.name).sort();

describe("useWatch", () => {
  beforeEach(() => {
    resetMock();
    handlers.connect = ({ context }: { context: string }) => ({
      context,
      serverVersion: "v1.33",
      defaultNamespace: "default",
      metrics: false,
      resources: [],
    });
  });
  afterEach(resetMock);

  it("applies the initial list and later changes", async () => {
    const { result } = renderHook(() => useWatch("/v1/namespaces", null));
    await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(1));
    const [w] = liveWatches("/v1/namespaces");

    act(() => w.channel.send({ type: "reset", items: [obj("default"), obj("kube-system")] }));
    await waitFor(() => expect(names(result.current.items)).toEqual(["default", "kube-system"]));
    expect(result.current.loading).toBe(false);

    act(() => w.channel.send({ type: "apply", object: obj("payments") }));
    act(() => w.channel.send({ type: "delete", object: obj("default") }));
    await waitFor(() => expect(names(result.current.items)).toEqual(["kube-system", "payments"]));
  });

  // Regression: the same key (`/v1/namespaces`) on another cluster kept showing the first cluster's list,
  // because the hook never re-subscribed after a cluster switch.
  it("re-subscribes after switching clusters and drops the old cluster's objects", async () => {
    const { result } = renderHook(() => useWatch("/v1/namespaces", null));
    await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(1));
    act(() => liveWatches("/v1/namespaces")[0].channel.send({ type: "reset", items: [obj("cluster-a-only")] }));
    await waitFor(() => expect(names(result.current.items)).toEqual(["cluster-a-only"]));

    await act(() => api.connect(ctx("cluster-b")).then(() => {}));

    await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(1));
    // Nothing from cluster A survives the switch, even before cluster B answers.
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(true);

    act(() => liveWatches("/v1/namespaces")[0].channel.send({ type: "reset", items: [obj("cluster-b-only")] }));
    await waitFor(() => expect(names(result.current.items)).toEqual(["cluster-b-only"]));
  });

  it("re-subscribes on reconnect to the same cluster", async () => {
    renderHook(() => useWatch("/v1/pods", "default"));
    await waitFor(() => expect(liveWatches("/v1/pods")).toHaveLength(1));
    const first = liveWatches("/v1/pods")[0];

    await act(() => api.connect(ctx("cluster-a")).then(() => {}));

    await waitFor(() => expect(first.stopped).toBe(true));
    expect(liveWatches("/v1/pods")).toHaveLength(1);
    expect(liveWatches("/v1/pods")[0]).not.toBe(first);
  });

  it("stops watching on unmount", async () => {
    const { unmount } = renderHook(() => useWatch("/v1/nodes", null));
    await waitFor(() => expect(liveWatches("/v1/nodes")).toHaveLength(1));
    unmount();
    await waitFor(() => expect(liveWatches("/v1/nodes")).toHaveLength(0));
  });

  it("does nothing without a key", async () => {
    const { result } = renderHook(() => useWatch(undefined, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([]);
  });
});
