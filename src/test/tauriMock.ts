// A fake Tauri backend for tests (loaded as a vitest setup file): `invoke`
// dispatches to per-test handlers, and watch channels can be fed events.
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import type { KubeObject, WatchEvent } from "../api";

// Browser APIs jsdom lacks.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

Element.prototype.scrollIntoView ??= function () {};
// xterm probes a 2D canvas at import time; jsdom has none.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

type Handler = (args: any) => unknown;

export const handlers: Record<string, Handler> = {};

/** Open watches, newest last: what the UI is subscribed to right now. */
export const watches: {
  id: string;
  cluster: string;
  key: string;
  namespace: string | null;
  channel: FakeChannel<WatchEvent>;
  stopped: boolean;
}[] = [];

export class FakeChannel<T> {
  id = Math.random();
  onmessage: (m: T) => void = () => {};
  send(m: T) {
    this.onmessage(m);
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: FakeChannel,
  invoke: vi.fn(async (cmd: string, args: any = {}) => {
    if (cmd === "watch_resources") {
      watches.push({ id: args.watchId, cluster: args.cluster, key: args.key, namespace: args.namespace, channel: args.onEvent, stopped: false });
      return;
    }
    if (cmd === "stop_stream") {
      for (const w of watches) if (w.id === args.id) w.stopped = true;
      return;
    }
    // Like the backend: (re)connecting or disconnecting a cluster drops that cluster's streams.
    const cluster = cmd === "connect" ? `${args.file}#${args.context}` : cmd === "disconnect" ? args.cluster : undefined;
    if (cluster) for (const w of watches) if (w.cluster === cluster) w.stopped = true;
    const h = handlers[cmd];
    if (!h) return null;
    return h(args);
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));

/** Live (not stopped) watches of a resource key, optionally of one cluster. */
export const liveWatches = (key: string, cluster?: string) =>
  watches.filter((w) => w.key === key && !w.stopped && (!cluster || w.cluster === cluster));

export const obj = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  metadata: { name, uid: `uid-${name}` },
  ...extra,
});

export function resetMock() {
  for (const k of Object.keys(handlers)) delete handlers[k];
  watches.length = 0;
}

// Unmount what each test rendered, so its watches don't leak into the next test.
afterEach(() => {
  cleanup();
  resetMock();
});
