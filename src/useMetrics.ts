import { useEffect, useState } from "react";
import { api } from "./api";
import { useConnectionEpoch } from "./useWatch";
import { parseQuantity } from "./util";

export interface Usage {
  cpu: number; // cores
  memory: number; // bytes
}

/** `namespace/name` (or `name` for nodes) -> usage */
export type MetricsMap = Map<string, Usage>;

const POLL_MS = 30_000;

export const metricsKey = (name: string, namespace?: string) => (namespace ? `${namespace}/${name}` : name);

/** Polls metrics-server. Returns null while unavailable. */
export function useMetrics(scope: "pods" | "nodes", namespace: string | null, enabled: boolean): MetricsMap | null {
  const [map, setMap] = useState<MetricsMap | null>(null);
  const epoch = useConnectionEpoch();

  useEffect(() => {
    setMap(null);
    if (!enabled) return;
    let alive = true;
    const load = () =>
      api
        .getMetrics(scope, namespace)
        .then((items) => {
          if (!alive) return;
          const m: MetricsMap = new Map();
          for (const it of items) {
            const parts: any[] = scope === "pods" ? (it.containers ?? []) : [it];
            const usage = parts.reduce(
              (acc, c) => ({
                cpu: acc.cpu + parseQuantity(c.usage?.cpu),
                memory: acc.memory + parseQuantity(c.usage?.memory),
              }),
              { cpu: 0, memory: 0 },
            );
            m.set(metricsKey(it.metadata.name, scope === "pods" ? it.metadata.namespace : undefined), usage);
          }
          setMap(m);
        })
        .catch(() => alive && setMap(null));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [scope, namespace, enabled, epoch]);

  return map;
}
