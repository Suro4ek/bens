import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import type { ContextInfo, ResourceInfo } from "./api";
import { handlers, liveWatches, obj } from "./test/tauriMock";

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

const R = (group: string, kind: string, plural: string, namespaced = true): ResourceInfo => ({
  key: `${group}/v1/${plural}`,
  group,
  version: "v1",
  kind,
  plural,
  namespaced,
});
const resources = [R("", "Pod", "pods"), R("", "Namespace", "namespaces", false)];

const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

/** Feeds a cluster's live watch of a resource, as the API server would. */
async function clusterHas(cluster: ContextInfo, key: string, ...names: string[]) {
  await waitFor(() => expect(liveWatches(key, cluster.id)).toHaveLength(1));
  act(() =>
    liveWatches(key, cluster.id)[0].channel.send({
      type: "reset",
      items: names.map((n) => obj(n, { metadata: { name: n, namespace: "default", uid: `${cluster.name}-${n}` } })),
    }),
  );
  // Watch updates are applied on the next animation frame.
  await nextFrame();
}

const connectedClusters = () => [...document.querySelectorAll(".tree-row.cluster.connected .tree-label")].map((e) => e.textContent);
const focusedCluster = () => document.querySelector(".tree-row.cluster.focused .tree-label")?.textContent;
const tabTitles = () => [...document.querySelectorAll(".main-tab .tab-title")].map((e) => e.textContent);
const nsButton = () => document.querySelector(".ns-select-btn") as HTMLElement;
const openTab = (title: string) => fireEvent.click(screen.getByTitle(title));

/** Connects cluster B from the Navigator while A stays connected. */
async function connectB() {
  fireEvent.click(screen.getByText("cluster-b"));
  await waitFor(() => expect(focusedCluster()).toBe("cluster-b"));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lastContext", A.id);
  for (const c of [A, B]) {
    localStorage.setItem(`tabs:${c.id}`, JSON.stringify(["/pods"]));
    localStorage.setItem(`view:${c.id}`, "/pods");
  }
  handlers.list_contexts = () => ({ current: A.name, sources: [], contexts: [A, B] });
  handlers.connect = ({ context }: { context: string }) => ({
    context,
    serverVersion: "v1.33",
    defaultNamespace: "default",
    metrics: false,
    resources,
  });
  handlers.port_forward_list = () => [];
});

describe("several connected clusters", () => {
  it("keeps the first cluster connected when a second one connects", async () => {
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    await clusterHas(A, "/v1/pods", "pod-a");

    await connectB();

    expect(connectedClusters()).toEqual(["cluster-a", "cluster-b"]);
    expect(tabTitles()).toEqual(["Pods - cluster-a", "Pods - cluster-b"]);

    // Back on A's tab, its pods are listed again, from cluster A.
    openTab("Pods - cluster-a");
    await clusterHas(A, "/v1/pods", "pod-a");
    expect(screen.getByText("pod-a")).toBeTruthy();
    expect(focusedCluster()).toBe("cluster-a");
  });

  it("shows each cluster's own namespaces and pods", async () => {
    render(<App />);
    await clusterHas(A, "/v1/namespaces", "a-only", "shared");
    await clusterHas(A, "/v1/pods", "pod-a");
    expect(screen.getByText("pod-a")).toBeTruthy();

    await connectB();
    await clusterHas(B, "/v1/namespaces", "b-only", "shared");
    await clusterHas(B, "/v1/pods", "pod-b");

    expect(screen.getByText("pod-b")).toBeTruthy();
    expect(screen.queryByText("pod-a")).toBeNull();
    fireEvent.click(nsButton());
    const menu = document.querySelector(".ns-menu") as HTMLElement;
    expect(within(menu).getByText("b-only")).toBeTruthy();
    expect(within(menu).queryByText("a-only")).toBeNull();
  });

  it("keeps a namespace chosen per cluster", async () => {
    render(<App />);
    await clusterHas(A, "/v1/namespaces", "a-only");
    fireEvent.click(nsButton());
    fireEvent.click(screen.getByText("a-only"));
    expect(nsButton().textContent).toContain("a-only");

    await connectB();
    await clusterHas(B, "/v1/namespaces", "b-only");
    expect(nsButton().textContent).toContain("All namespaces");

    openTab("Pods - cluster-a");
    await waitFor(() => expect(focusedCluster()).toBe("cluster-a"));
    expect(nsButton().textContent).toContain("a-only");
  });

  it("disconnecting one cluster leaves the other one and its tabs", async () => {
    let disconnected: string | undefined;
    handlers.disconnect = ({ cluster }: { cluster: string }) => void (disconnected = cluster);
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    await connectB();
    await waitFor(() => expect(liveWatches("/v1/pods", B.id)).toHaveLength(1));
    const bWatch = liveWatches("/v1/pods", B.id)[0];

    fireEvent.contextMenu(screen.getByText("cluster-a"));
    fireEvent.click(screen.getByText("Disconnect"));

    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-b"]));
    expect(disconnected).toBe(A.id);
    expect(tabTitles()).toEqual(["Pods - cluster-b"]);
    expect(bWatch.stopped).toBe(false);
  });

  it("closing the last cluster tab and disconnecting everything goes back to the catalog", async () => {
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    fireEvent.contextMenu(screen.getByText("cluster-a"));
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(connectedClusters()).toEqual([]));
    expect(tabTitles()).toEqual(["Catalog"]);
  });
});

describe("dock tabs", () => {
  it("stay bound to the cluster they were opened for", async () => {
    const terminals: string[] = [];
    handlers.local_terminal_start = ({ cluster }: { cluster: string }) => void terminals.push(cluster);
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    await connectB();

    // B is on screen; open a terminal for A from its menu.
    fireEvent.contextMenu(screen.getByText("cluster-a"));
    fireEvent.click(screen.getByText("Open terminal"));

    await waitFor(() => expect(terminals).toEqual([A.id]));
    expect(focusedCluster()).toBe("cluster-b");
    // With two clusters connected the dock tab says which cluster it is for.
    expect(document.querySelector(".dock-tab .dock-title")?.textContent).toContain("cluster-a");
  });
});

describe("cluster context menu", () => {
  const menuItems = () => [...document.querySelectorAll(".ctx-menu .ctx-item")].map((e) => e.textContent);

  it("offers Reconnect / Disconnect on connected clusters and Connect on others", async () => {
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));

    fireEvent.contextMenu(screen.getByText("cluster-a"));
    expect(menuItems()).toEqual(expect.arrayContaining(["Reconnect", "Disconnect", "Open terminal", "Settings"]));
    expect(menuItems()).not.toContain("Connect");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".ctx-menu")).toBeNull();

    fireEvent.contextMenu(screen.getByText("cluster-b"));
    expect(menuItems()).toContain("Connect");
    expect(menuItems()).not.toContain("Reconnect");
  });

  it("Reconnect re-subscribes that cluster's lists only", async () => {
    let connects = 0;
    const base = handlers.connect;
    handlers.connect = (args) => (connects++, base(args));
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    await connectB();
    openTab("Pods - cluster-a");
    await waitFor(() => expect(liveWatches("/v1/namespaces", A.id)).toHaveLength(1));
    const before = liveWatches("/v1/namespaces", A.id)[0];

    fireEvent.contextMenu(screen.getByText("cluster-a"));
    fireEvent.click(screen.getByText("Reconnect"));

    await waitFor(() => expect(connects).toBe(3));
    await waitFor(() => expect(liveWatches("/v1/namespaces", A.id)).toHaveLength(1));
    expect(liveWatches("/v1/namespaces", A.id)[0]).not.toBe(before);
    expect(connectedClusters()).toEqual(["cluster-a", "cluster-b"]);
  });
});
