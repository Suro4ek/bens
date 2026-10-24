import { describe, expect, it, vi } from "vitest";
import type { ContextInfo } from "./api";
import { clusterMenuItems } from "./clusterMenu";
import { tabMenuItems } from "./components/ObjectMenu";

describe("tab menu", () => {
  const ids = ["a", "b", "c", "d"];
  const labels = (id: string) => tabMenuItems(ids, id, () => {}).map((i) => i.label);

  it("offers only the closing actions that apply", () => {
    expect(labels("a")).toEqual(["Close", "Close other tabs", "Close tabs to the right", "Close all tabs"]);
    expect(labels("d")).toEqual(["Close", "Close other tabs", "Close tabs to the left", "Close all tabs"]);
    expect(tabMenuItems(["a"], "a", () => {}).map((i) => i.label)).toEqual(["Close", "Close all tabs"]);
  });

  it("closes the right tabs and keeps the clicked one active", () => {
    const close = vi.fn();
    const run = (id: string, label: string) => tabMenuItems(ids, id, close).find((i) => i.label === label)!.run!();
    run("b", "Close tabs to the left");
    expect(close).toHaveBeenLastCalledWith(["a"], "b");
    run("b", "Close tabs to the right");
    expect(close).toHaveBeenLastCalledWith(["c", "d"], "b");
    run("b", "Close other tabs");
    expect(close).toHaveBeenLastCalledWith(["a", "c", "d"], "b");
  });
});

describe("cluster menu", () => {
  const ctx: ContextInfo = { id: "f#c", name: "c", file: "/k/config", pasted: false, cluster: "c", user: "u" };
  const actions = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    settings: vi.fn(),
    terminal: vi.fn(),
    setHotbar: vi.fn(),
    copy: vi.fn(),
    reveal: vi.fn(),
    remove: vi.fn(),
  });

  it("reconnects the connected cluster", () => {
    const a = actions();
    const items = clusterMenuItems(ctx, { active: true, connecting: false }, a);
    items.find((i) => i.label === "Reconnect")!.run!();
    expect(a.connect).toHaveBeenCalledWith(ctx);
    items.find((i) => i.label === "Disconnect")!.run!();
    expect(a.disconnect).toHaveBeenCalledWith(ctx);
  });

  it("toggles the hotbar and hides folder actions for pasted kubeconfigs", () => {
    const a = actions();
    const hidden = clusterMenuItems({ ...ctx, pasted: true }, { active: false, connecting: false, prefs: { hideFromHotbar: true } }, a);
    expect(hidden.map((i) => i.label)).not.toContain("Show kubeconfig in folder");
    hidden.find((i) => i.label === "Add to hotbar")!.run!();
    expect(a.setHotbar).toHaveBeenCalledWith(expect.objectContaining({ pasted: true }), true);
  });

  it("does not connect twice while connecting", () => {
    const a = actions();
    clusterMenuItems(ctx, { active: false, connecting: true }, a).find((i) => i.label === "Connecting…")!.run!();
    expect(a.connect).not.toHaveBeenCalled();
  });
});
