import { useEffect, useState } from "react";
import { api, PromSeries } from "../api";
import { useActiveClusterPrefs } from "../prefs";
import { useConnectionEpoch } from "../useWatch";

const RANGE_S = 60 * 60; // last hour
const STEP_S = 60;
const POLL_MS = 60_000;

/** Whether Prometheus was found in the cluster; checked once per connection. */
let promAvailable: Promise<boolean> | null = null;
export const resetPrometheus = () => (promAvailable = null);
const hasPrometheus = () => (promAvailable ??= api.prometheusDetect().then((s) => !!s, () => false));

/** Whether Prometheus charts can be shown (null while checking). */
export function usePrometheusAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  const epoch = useConnectionEpoch();
  useEffect(() => {
    let alive = true;
    setAvailable(null);
    hasPrometheus().then((v) => alive && setAvailable(v));
    return () => {
      alive = false;
    };
  }, [epoch]);
  return available;
}

export interface ChartQuery {
  label: string;
  query: string;
  color: string;
}

/** Runs range queries over the last hour, refreshing every minute. */
export function usePromRange(queries: ChartQuery[]): { data: (PromSeries | null)[]; available: boolean | null } {
  const [data, setData] = useState<(PromSeries | null)[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const key = queries.map((q) => q.query).join("\n");
  const epoch = useConnectionEpoch();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!(await hasPrometheus())) {
        if (alive) setAvailable(false);
        return;
      }
      const end = Math.floor(Date.now() / 1000);
      const results = await Promise.all(
        queries.map((q) =>
          api
            .prometheusRange(q.query, end - RANGE_S, end, STEP_S)
            .then((s) => s[0] ?? null)
            .catch(() => null),
        ),
      );
      if (alive) {
        setAvailable(true);
        setData(results);
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, epoch]);

  return { data, available };
}

/** Chart groups that can be hidden in cluster settings. */
export type MetricsGroup = "cluster" | "node" | "pod";
export const useMetricsHidden = (group: MetricsGroup) => !!useActiveClusterPrefs().hiddenMetrics?.includes(group);

interface ChartProps {
  title: string;
  queries: ChartQuery[];
  format: (v: number) => string;
}

const W = 360;
const H = 110;
const PAD = { l: 44, r: 6, t: 6, b: 16 };

export function PromChart({ title, queries, format }: ChartProps) {
  const { data, available } = usePromRange(queries);
  if (available === false) return null;

  const all = data.flatMap((s) => s?.values ?? []);
  const tMin = Math.min(...all.map((p) => p[0]));
  const tMax = Math.max(...all.map((p) => p[0]));
  const vMax = Math.max(...all.map((p) => p[1]), 0) * 1.1 || 1;
  const x = (t: number) => PAD.l + ((t - tMin) / (tMax - tMin || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / vMax) * (H - PAD.t - PAD.b);

  return (
    <div className="chart">
      <div className="row-between small">
        <b>{title}</b>
        <span className="legend">
          {queries.map((q, i) => (
            <span key={q.label}>
              <i style={{ background: q.color }} /> {q.label}
              {data[i]?.values.length ? ` ${format(data[i]!.values.at(-1)![1])}` : ""}
            </span>
          ))}
        </span>
      </div>
      {all.length === 0 ? (
        <div className="muted small chart-empty">{available === null ? "Loading…" : "No data"}</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={title}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(vMax * f)} y2={y(vMax * f)} className="grid" />
              <text x={PAD.l - 4} y={y(vMax * f) + 3} textAnchor="end" className="axis">
                {format(vMax * f)}
              </text>
            </g>
          ))}
          <text x={PAD.l} y={H - 3} className="axis">
            -1h
          </text>
          <text x={W - PAD.r} y={H - 3} textAnchor="end" className="axis">
            now
          </text>
          {data.map((s, i) =>
            s?.values.length ? (
              <polyline
                key={queries[i].label}
                fill="none"
                stroke={queries[i].color}
                strokeWidth={1.6}
                points={s.values.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
              />
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
}

/** PromQL used by the charts (cAdvisor + kube-state-metrics series, as kube-prometheus-stack provides them). */
export const promQueries = {
  clusterCpu: 'sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))',
  clusterMem: 'sum(container_memory_working_set_bytes{container!="",container!="POD"})',
  clusterCpuReq: 'sum(kube_pod_container_resource_requests{resource="cpu"})',
  clusterMemReq: 'sum(kube_pod_container_resource_requests{resource="memory"})',
  podCpu: (ns: string, pod: string) =>
    `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod="${pod}",container!="",container!="POD"}[5m]))`,
  podMem: (ns: string, pod: string) =>
    `sum(container_memory_working_set_bytes{namespace="${ns}",pod="${pod}",container!="",container!="POD"})`,
  podCpuReq: (ns: string, pod: string) =>
    `sum(kube_pod_container_resource_requests{namespace="${ns}",pod="${pod}",resource="cpu"})`,
  podMemReq: (ns: string, pod: string) =>
    `sum(kube_pod_container_resource_requests{namespace="${ns}",pod="${pod}",resource="memory"})`,
  nodeCpu: (node: string) =>
    `sum(rate(container_cpu_usage_seconds_total{node="${node}",container!="",container!="POD"}[5m]))`,
  nodeMem: (node: string) => `sum(container_memory_working_set_bytes{node="${node}",container!="",container!="POD"})`,
};
