import type { Connection, KubeObject } from "../api";
import { CircleAlert, CircleCheck } from "lucide-react";
import { NamespaceSelect } from "./NamespaceSelect";
import { navId } from "../nav";
import { metricsKey, MetricsMap } from "../useMetrics";
import { useWatch } from "../useWatch";
import { age, formatBytes, formatCpu, nodeStatus, parseQuantity, podStatus } from "../util";
import { PromChart, promQueries, useMetricsHidden, usePrometheusAvailable } from "./Charts";

interface Props {
  conn: Connection;
  namespace: string | null;
  nodeMetrics: MetricsMap | null;
  onOpen: (navId: string) => void;
}

function Stat({ label, value, tone, onClick }: { label: string; value: number | string; tone?: string; onClick?: () => void }) {
  return (
    <button className="stat" onClick={onClick} disabled={!onClick}>
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      <div className="muted small">{label}</div>
    </button>
  );
}

export function Overview({ conn, namespace, nodeMetrics, onOpen }: Props) {
  const prometheus = usePrometheusAvailable();
  const chartsHidden = useMetricsHidden("cluster") || prometheus === false;
  const key = (id: string) => conn.resources.find((r) => navId(r) === id)?.key;
  const nodes = useWatch(key("/nodes"), null);
  const pods = useWatch(key("/pods"), namespace);
  const warnings = useWatch(key("/events"), namespace, { fieldSelector: "type=Warning" });

  const byStatus = new Map<string, number>();
  for (const p of pods.items) {
    const s = podStatus(p);
    const bucket = /^(Running|Succeeded|Completed|Pending)$/.test(s) ? s : "Failing";
    byStatus.set(bucket, (byStatus.get(bucket) ?? 0) + 1);
  }

  const sum = (f: (n: KubeObject) => number) => nodes.items.reduce((acc, n) => acc + f(n), 0);
  const cpuAlloc = sum((n) => parseQuantity(n.status?.allocatable?.cpu));
  const memAlloc = sum((n) => parseQuantity(n.status?.allocatable?.memory));
  const cpuUsed = sum((n) => nodeMetrics?.get(metricsKey(n.metadata.name))?.cpu ?? 0);
  const memUsed = sum((n) => nodeMetrics?.get(metricsKey(n.metadata.name))?.memory ?? 0);
  // Requests show how much of the cluster is reserved, even without metrics-server.
  const requests = pods.items
    .filter((p) => !/^(Succeeded|Failed)$/.test(p.status?.phase))
    .flatMap((p) => (p.spec?.containers ?? []) as any[])
    .reduce(
      (acc, c) => ({
        cpu: acc.cpu + parseQuantity(c.resources?.requests?.cpu),
        memory: acc.memory + parseQuantity(c.resources?.requests?.memory),
      }),
      { cpu: 0, memory: 0 },
    );

  const limits = pods.items
    .filter((p) => !/^(Succeeded|Failed)$/.test(p.status?.phase))
    .flatMap((p) => (p.spec?.containers ?? []) as any[])
    .reduce(
      (acc, c) => ({
        cpu: acc.cpu + parseQuantity(c.resources?.limits?.cpu),
        memory: acc.memory + parseQuantity(c.resources?.limits?.memory),
      }),
      { cpu: 0, memory: 0 },
    );
  const cpuCap = sum((n) => parseQuantity(n.status?.capacity?.cpu));
  const memCap = sum((n) => parseQuantity(n.status?.capacity?.memory));
  const podsAlloc = sum((n) => parseQuantity(n.status?.allocatable?.pods));
  const podsCap = sum((n) => parseQuantity(n.status?.capacity?.pods));
  const activePods = pods.items.filter((p) => !/^(Succeeded|Failed)$/.test(p.status?.phase)).length;

  const recentWarnings = [...warnings.items]
    .sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0))
    .slice(0, 50);
  const readyNodes = nodes.items.filter((n) => nodeStatus(n).startsWith("Ready")).length;

  return (
    <div className="overview">
      <div className="view-head">
        <h2>Cluster Overview</h2>
        <div className="spacer" />
        <NamespaceSelect />
      </div>

      <div className="ov-top">
        {!chartsHidden && (
          <div className="ov-chart">
            <PromChart
              title="CPU"
              format={formatCpu}
              queries={[
                { label: "usage", query: promQueries.clusterCpu, color: RING.usage },
                { label: "requests", query: promQueries.clusterCpuReq, color: RING.requests },
              ]}
            />
            <PromChart
              title="Memory"
              format={formatBytes}
              queries={[
                { label: "usage", query: promQueries.clusterMem, color: RING.usage },
                { label: "requests", query: promQueries.clusterMemReq, color: RING.requests },
              ]}
            />
          </div>
        )}
        <div className="ov-rings">
          <RingPanel
            title="CPU"
            capacity={cpuCap}
            format={formatCpu}
            rows={[
              ...(nodeMetrics ? [{ label: "Usage", value: cpuUsed, color: RING.usage }] : []),
              { label: "Requests", value: requests.cpu, color: RING.requests },
              { label: "Limits", value: limits.cpu, color: RING.limits },
            ]}
            allocatable={cpuAlloc}
          />
          <RingPanel
            title="Memory"
            capacity={memCap}
            format={formatBytes}
            rows={[
              ...(nodeMetrics ? [{ label: "Usage", value: memUsed, color: RING.usage }] : []),
              { label: "Requests", value: requests.memory, color: RING.requests },
              { label: "Limits", value: limits.memory, color: RING.limits },
            ]}
            allocatable={memAlloc}
          />
          <RingPanel
            title="Pods"
            capacity={podsCap}
            format={(v) => String(Math.round(v))}
            rows={[{ label: "Usage", value: activePods, color: RING.requests }]}
            allocatable={podsAlloc}
          />
        </div>
      </div>
      {!conn.metrics && (
        <p className="muted small">metrics-server is not installed — live usage is unavailable, requests and limits are shown.</p>
      )}

      <div className="stats">
        <Stat label="Nodes ready" value={`${readyNodes}/${nodes.items.length}`} tone={readyNodes < nodes.items.length ? "warn" : ""} onClick={() => onOpen("/nodes")} />
        <Stat label="Pods" value={pods.items.length} onClick={() => onOpen("/pods")} />
        <Stat label="Running" value={byStatus.get("Running") ?? 0} tone="ok" />
        <Stat label="Pending" value={byStatus.get("Pending") ?? 0} tone="warn" />
        <Stat label="Failing" value={byStatus.get("Failing") ?? 0} tone="bad" />
      </div>

      <div className="ov-warnings">
        <div className="ov-warnings-head">
          {recentWarnings.length ? (
            <>
              <CircleAlert size={18} className="status bad" /> Warnings: {warnings.items.length}
            </>
          ) : (
            <>
              <CircleCheck size={18} className="status ok" /> No warnings
            </>
          )}
        </div>
        {recentWarnings.length > 0 && (
          <div className="table plain">
            <div className="tr th" style={{ gridTemplateColumns: WARN_COLS }}>
              <div className="td">Message</div>
              <div className="td">Object</div>
              <div className="td">Type</div>
              <div className="td">Age</div>
            </div>
            {recentWarnings.map((e) => (
              <div key={e.metadata.uid} className="tr" style={{ gridTemplateColumns: WARN_COLS }} title={e.message}>
                <div className="td">
                  <b>{e.reason}</b> {e.message}
                </div>
                <div className="td">{e.involvedObject?.name}</div>
                <div className="td">{e.involvedObject?.kind}</div>
                <div className="td">{age(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const WARN_COLS = "minmax(200px, 1fr) minmax(120px, 220px) 120px 70px";
/** Overview colors: usage magenta, requests green, limits blue. */
const RING = { usage: "#c93dce", requests: "#4caf50", limits: "#3d90ce" };

interface RingRow {
  label: string;
  value: number;
  color: string;
}

/** Concentric arcs (one per row) relative to capacity, with a legend */
function RingPanel({
  title,
  rows,
  allocatable,
  capacity,
  format,
}: {
  title: string;
  rows: RingRow[];
  allocatable: number;
  capacity: number;
  format: (v: number) => string;
}) {
  const size = 120;
  const stroke = 6;
  return (
    <div className="ring-panel">
      <h4>{title}</h4>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ring">
        {rows.map((r, i) => {
          const radius = size / 2 - stroke / 2 - i * (stroke + 3);
          const c = 2 * Math.PI * radius;
          const frac = capacity > 0 ? Math.min(r.value / capacity, 1) : 0;
          return (
            <g key={r.label}>
              <circle cx={size / 2} cy={size / 2} r={radius} className="ring-track" strokeWidth={stroke} fill="none" />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={r.color}
                strokeWidth={stroke}
                fill="none"
                strokeDasharray={`${c * frac} ${c}`}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                strokeLinecap="round"
              />
            </g>
          );
        })}
      </svg>
      <div className="ring-legend">
        {rows.map((r) => (
          <div key={r.label}>
            <i style={{ background: r.color }} /> {r.label}: {format(r.value)}
          </div>
        ))}
        <div>
          <i className="faint" /> Allocatable: {format(allocatable)}
        </div>
        <div>
          <i className="faint" /> Capacity: {format(capacity)}
        </div>
      </div>
    </div>
  );
}
