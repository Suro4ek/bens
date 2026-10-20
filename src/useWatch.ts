import { useEffect, useState } from "react";
import { api, KubeObject, WatchOptions } from "./api";

const objKey = (o: KubeObject) => o.metadata.uid ?? `${o.metadata.namespace}/${o.metadata.name}`;

export interface WatchState {
  items: KubeObject[];
  loading: boolean;
  error?: string;
}

/** Live list of objects of one resource type, kept up to date by a Kubernetes watch. */
export function useWatch(key: string | undefined, namespace: string | null, opts: WatchOptions = {}): WatchState {
  const { labelSelector, fieldSelector } = opts;
  const [state, setState] = useState<WatchState>({ items: [], loading: true });

  useEffect(() => {
    if (!key) {
      setState({ items: [], loading: false });
      return;
    }
    setState({ items: [], loading: true });

    const map = new Map<string, KubeObject>();
    let frame = 0;
    let error: string | undefined;
    let loaded = false;
    // Coalesce bursts of watch events into one render per animation frame.
    const flush = () => {
      frame = 0;
      setState({ items: Array.from(map.values()), loading: !loaded, error });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const stop = api.watch(key, namespace, (e) => {
      switch (e.type) {
        case "reset":
          map.clear();
          for (const o of e.items) map.set(objKey(o), o);
          loaded = true;
          error = undefined;
          break;
        case "apply":
          map.set(objKey(e.object), e.object);
          break;
        case "delete":
          map.delete(objKey(e.object));
          break;
        case "error":
          error = e.message;
          break;
      }
      schedule();
    }, { labelSelector, fieldSelector });

    return () => {
      stop();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key, namespace, labelSelector, fieldSelector]);

  return state;
}

/** Watches several resource types at once; returns items per key. */
export function useWatchMany(keys: string[], namespace: string | null): Record<string, WatchState> {
  const [state, setState] = useState<Record<string, WatchState>>({});
  const joined = keys.join("|");

  useEffect(() => {
    const maps = new Map<string, Map<string, KubeObject>>();
    const meta = new Map<string, { loaded: boolean; error?: string }>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      const next: Record<string, WatchState> = {};
      for (const k of keys) {
        const m = meta.get(k);
        next[k] = { items: Array.from(maps.get(k)?.values() ?? []), loading: !m?.loaded, error: m?.error };
      }
      setState(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    setState({});
    const stops = keys.map((k) => {
      const map = new Map<string, KubeObject>();
      maps.set(k, map);
      meta.set(k, { loaded: false });
      return api.watch(k, namespace, (e) => {
        if (e.type === "reset") {
          map.clear();
          for (const o of e.items) map.set(objKey(o), o);
          meta.set(k, { loaded: true });
        } else if (e.type === "apply") map.set(objKey(e.object), e.object);
        else if (e.type === "delete") map.delete(objKey(e.object));
        else meta.set(k, { loaded: true, error: e.message });
        schedule();
      });
    });
    return () => {
      stops.forEach((s) => s());
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, namespace]);

  return state;
}
