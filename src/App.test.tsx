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
const resources = [R("", "Pod", "pods"), R("", "Namespace", "namespaces", false), R("", "Secret", "secrets")];

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
  const dockTabs = () => [...document.querySelectorAll(".dock-tab .dock-title")].map((e) => e.textContent);

  it("each cluster has its own dock, and its terminals keep running while another is shown", async () => {
    const terminals: string[] = [];
    const stopped: string[] = [];
    handlers.local_terminal_start = ({ cluster }: { cluster: string }) => void terminals.push(cluster);
    handlers.exec_stop = ({ id }: { id: string }) => void stopped.push(id);
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    await connectB();

    // B is on screen; a terminal opened for A from its menu brings A up with it.
    fireEvent.contextMenu(screen.getByText("cluster-a"));
    fireEvent.click(screen.getByText("Open terminal"));
    await waitFor(() => expect(terminals).toEqual([A.id]));
    await waitFor(() => expect(focusedCluster()).toBe("cluster-a"));
    expect(dockTabs()).toEqual(["Terminal - cluster-a"]);

    // On B, A's terminal isn't shown, so it can't be mistaken for B's.
    openTab("Pods - cluster-b");
    await waitFor(() => expect(focusedCluster()).toBe("cluster-b"));
    expect(dockTabs()).toEqual([]);
    fireEvent.click(screen.getByTitle("New terminal (⌘`)"));
    await waitFor(() => expect(terminals).toEqual([A.id, B.id]));
    expect(dockTabs()).toEqual(["Terminal - cluster-b"]);

    // Back on A, its terminal is the same session: it kept running.
    openTab("Pods - cluster-a");
    await waitFor(() => expect(dockTabs()).toEqual(["Terminal - cluster-a"]));
    expect(terminals).toEqual([A.id, B.id]);
    expect(stopped).toEqual([]);
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

describe("copying a secret to another cluster", () => {
  it("copies it into the chosen cluster and namespace, cleaned of the source's identity", async () => {
    const calls: { cmd: string; args: any }[] = [];
    handlers.create_resource = (args) => (calls.push({ cmd: "create", args }), args.object);
    localStorage.setItem(`tabs:${A.id}`, JSON.stringify(["/secrets"]));
    localStorage.setItem(`view:${A.id}`, "/secrets");
    render(<App />);
    await waitFor(() => expect(connectedClusters()).toEqual(["cluster-a"]));
    await connectB();
    openTab("Secrets - cluster-a");
    await waitFor(() => expect(liveWatches("/v1/secrets", A.id)).toHaveLength(1));
    act(() =>
      liveWatches("/v1/secrets", A.id)[0].channel.send({
        type: "reset",
        items: [
          {
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: { name: "db-creds", namespace: "payments", uid: "s1", resourceVersion: "42" },
            data: { PASSWORD: "cGFzcw==" },
          },
        ],
      }),
    );
    await nextFrame();

    fireEvent.contextMenu(screen.getByText("db-creds"));
    fireEvent.click(screen.getByText("Copy to…"));
    // The other connected cluster is preselected; the namespace is the source's.
    expect((screen.getByDisplayValue("cluster-b") as HTMLSelectElement).value).toBe(B.id);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(calls.filter((c) => c.args.key === "/v1/secrets")).toHaveLength(1));
    const { args } = calls.find((c) => c.args.key === "/v1/secrets")!;
    expect(args.cluster).toBe(B.id);
    expect(args.namespace).toBe("payments");
    expect(args.object).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: "db-creds", namespace: "payments" },
      data: { PASSWORD: "cGFzcw==" },
    });
    // The namespace was ensured in B first.
    expect(calls.some((c) => c.args.key === "/v1/namespaces" && c.args.cluster === B.id)).toBe(true);
  });
});
