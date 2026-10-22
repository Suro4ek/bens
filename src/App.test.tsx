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

/** Feeds the newest namespaces watch, i.e. what the connected cluster has. */
async function clusterHasNamespaces(...names: string[]) {
  await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(1));
  act(() => liveWatches("/v1/namespaces")[0].channel.send({ type: "reset", items: names.map((n) => obj(n)) }));
  // Watch updates are applied on the next animation frame.
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

const clickNsButton = () => fireEvent.click(document.querySelector(".ns-select-btn")!);

describe("switching clusters", () => {
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

  it("shows the new cluster's namespaces, not the old one's", async () => {
    render(<App />);
    await clusterHasNamespaces("a-only", "shared");

    clickNsButton();
    expect(screen.getByText("a-only")).toBeTruthy();
    fireEvent.click(document.querySelector(".menu-backdrop")!);

    // Switch to cluster B from the Navigator.
    fireEvent.click(screen.getByText("cluster-b"));
    await waitFor(() => expect(document.querySelector(".tree-row.cluster.connected")?.textContent).toContain("cluster-b"));
    await clusterHasNamespaces("b-only", "shared");

    clickNsButton();
    const menu = document.querySelector(".ns-menu") as HTMLElement;
    expect(within(menu).getByText("b-only")).toBeTruthy();
    expect(within(menu).queryByText("a-only")).toBeNull();
  });

  it("keeps a namespace chosen per cluster instead of carrying it over", async () => {
    render(<App />);
    await clusterHasNamespaces("a-only", "shared");

    clickNsButton();
    fireEvent.click(screen.getByText("a-only"));
    expect(document.querySelector(".ns-select-btn")?.textContent).toContain("a-only");

    fireEvent.click(screen.getByText("cluster-b"));
    await waitFor(() => expect(document.querySelector(".tree-row.cluster.connected")?.textContent).toContain("cluster-b"));
    await clusterHasNamespaces("b-only");
    expect(document.querySelector(".ns-select-btn")?.textContent).toContain("All namespaces");

    // Back on A, its own choice comes back.
    fireEvent.click(screen.getByText("cluster-a"));
    await waitFor(() => expect(document.querySelector(".tree-row.cluster.connected")?.textContent).toContain("cluster-a"));
    expect(document.querySelector(".ns-select-btn")?.textContent).toContain("a-only");
  });

  it("lists pods of the new cluster only", async () => {
    render(<App />);
    await waitFor(() => expect(liveWatches("/v1/pods")).toHaveLength(1));
    act(() => liveWatches("/v1/pods")[0].channel.send({ type: "reset", items: [obj("pod-from-a", { metadata: { name: "pod-from-a", namespace: "x", uid: "a1" } })] }));
    expect(await screen.findByText("pod-from-a")).toBeTruthy();

    fireEvent.click(screen.getByText("cluster-b"));
    await waitFor(() => expect(document.querySelector(".tree-row.cluster.connected")?.textContent).toContain("cluster-b"));
    await waitFor(() => expect(liveWatches("/v1/pods")).toHaveLength(1));
    act(() => liveWatches("/v1/pods")[0].channel.send({ type: "reset", items: [obj("pod-from-b", { metadata: { name: "pod-from-b", namespace: "x", uid: "b1" } })] }));
    expect(await screen.findByText("pod-from-b")).toBeTruthy();
    expect(screen.queryByText("pod-from-a")).toBeNull();
  });
});

describe("cluster context menu", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("lastContext", A.id);
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

  const menuItems = () => [...document.querySelectorAll(".ctx-menu .ctx-item")].map((e) => e.textContent);
  const connected = () => document.querySelector(".tree-row.cluster.connected")?.textContent ?? "";

  it("offers Reconnect / Disconnect on the connected cluster and Connect on others", async () => {
    render(<App />);
    await waitFor(() => expect(connected()).toContain("cluster-a"));

    fireEvent.contextMenu(screen.getByText("cluster-a"));
    expect(menuItems()).toEqual(expect.arrayContaining(["Reconnect", "Disconnect", "Open terminal", "Settings"]));
    expect(menuItems()).not.toContain("Connect");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".ctx-menu")).toBeNull();

    fireEvent.contextMenu(screen.getByText("cluster-b"));
    expect(menuItems()).toContain("Connect");
    expect(menuItems()).not.toContain("Reconnect");
  });

  it("Reconnect re-subscribes the open lists", async () => {
    let connects = 0;
    const base = handlers.connect;
    handlers.connect = (args) => (connects++, base(args));
    render(<App />);
    await waitFor(() => expect(connected()).toContain("cluster-a"));
    await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(1));
    const before = liveWatches("/v1/namespaces")[0];

    fireEvent.contextMenu(screen.getByText("cluster-a"));
    fireEvent.click(screen.getByText("Reconnect"));

    await waitFor(() => expect(connects).toBe(2));
    await waitFor(() => expect(liveWatches("/v1/namespaces")).toHaveLength(1));
    expect(liveWatches("/v1/namespaces")[0]).not.toBe(before);
  });

  it("Connect switches to the clicked cluster and Disconnect returns to the catalog", async () => {
    let disconnected = false;
    handlers.disconnect = () => void (disconnected = true);
    render(<App />);
    await waitFor(() => expect(connected()).toContain("cluster-a"));

    fireEvent.contextMenu(screen.getByText("cluster-b"));
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(connected()).toContain("cluster-b"));

    fireEvent.contextMenu(screen.getByText("cluster-b"));
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(connected()).toBe(""));
    expect(disconnected).toBe(true);
  });
});
