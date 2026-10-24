import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Settings } from "lucide-react";
import { api, Connection } from "../api";
import { useApi } from "../clusterContext";
import { unlessSelecting } from "../clipboard";
import {
  COST_WINDOWS,
  CostAllocation,
  CostTrend,
  CostWindow,
  Detection,
  detectCostSource,
  efficiencyTone,
  ESTIMATE_NOTE,
  estimate,
  fetchBackendAllocation,
  fetchBackendTrend,
  formatEfficiency,
  formatMoney,
  formatRate,
  IDLE,
  loadObservations,
  NamespaceCost,
  Observations,
  ratesFrom,
  Segment,
  segments,
  withoutIdle,
} from "../cost";
import { navId } from "../nav";
import type { ClusterPrefs } from "../prefs";
import { useWatch } from "../useWatch";
import { storage } from "../util";

interface Props {
  conn: Connection;
  clusterId: string;
  prefs: ClusterPrefs;
  onNavigate: (navId: string, uid?: string, ref?: { namespace?: string; name: string }) => void;
  onOpenSettings: (section: string) => void;
}

const REFRESH_MS = 60_000;

/** Runs `load` when `key` changes and every minute; keeps the last value while reloading. */
function usePolled<T>(key: string | null, load: () => Promise<T>) {
  const [state, setState] = useState<{ key?: string; data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => alive && setState({ key, data, loading: false }),
      (e) => alive && setState({ key, error: String(e instanceof Error ? e.message : e), loading: false }),
    );
    const t = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

export function CostDashboard({ conn, clusterId, prefs, onNavigate, onOpenSettings }: Props) {
  const [window, setWindowState] = useState<CostWindow>(() => (storage.get(`costWindow:${clusterId}`) as CostWindow) || "7d");
  const [idle, setIdleState] = useState(() => storage.get(`costIdle:${clusterId}`) !== "0");
  const setWindow = (w: CostWindow) => (setWindowState(w), storage.set(`costWindow:${clusterId}`, w));
  const setIdle = (v: boolean) => (setIdleState(v), storage.set(`costIdle:${clusterId}`, v ? "1" : "0"));

  const settingsKey = [prefs.costSource, prefs.costAddress, prefs.prometheusMode, prefs.prometheusService].join("|");
  const capi = useApi();
  const detection = usePolled<Detection>(settingsKey, () => detectCostSource(capi, prefs));
  const det = detection.data;

  return (
    <div className="overview cost">
      <div className="view-head">
        <h2>Cost Monitoring</h2>
        <div className="spacer" />
        <button className="icon" title="Check again" onClick={detection.reload} disabled={detection.loading}>
          <RefreshCw size={15} className={detection.loading ? "spin" : ""} />
        </button>
        <button className="icon" title="Cost settings" onClick={() => onOpenSettings("cost")}>
          <Settings size={15} />
        </button>
      </div>
      {!det && !detection.error && <div className="panel muted">Looking for a cost source…</div>}
      {detection.error && !det && <div className="banner bad">{detection.error}</div>}
      {det?.status === "off" && (
        <div className="panel">
          <h4>Cost monitoring is off for this cluster</h4>
          <div>
            Turn it on in the <a href="#" onClick={(e) => (e.preventDefault(), onOpenSettings("cost"))}>cluster settings</a>.
          </div>
        </div>
      )}
      {(det?.status === "not-detected" || det?.status === "failed") && (
        <NotDetected detection={det} onOpenSettings={onOpenSettings} onCheckAgain={detection.reload} />
      )}
      {det?.status === "detected" && (
        <Detected
          key={`${det.source.id}|${det.source.handle}`}
          conn={conn}
          prefs={prefs}
          detection={det}
          window={window}
          setWindow={setWindow}
          idle={idle}
          setIdle={setIdle}
          onNavigate={onNavigate}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}

function NotDetected({
  detection,
  onOpenSettings,
  onCheckAgain,
}: {
  detection: Extract<Detection, { status: "not-detected" | "failed" }>;
  onOpenSettings: (s: string) => void;
  onCheckAgain: () => void;
}) {
  return (
    <div className="panel cost-callout">
      <h4>No cost source found</h4>
      {detection.status === "failed" && <div className="banner bad">{detection.error}</div>}
      <div>Bens shows costs from one of these, in this order:</div>
      <ul className="cost-candidates">
        {detection.candidates.map((c) => (
          <li key={c.id}>
            <b>{c.name}</b>{" "}
            <span className={`status ${c.outcome === "failed" ? "bad" : "muted"}`}>
              {c.outcome === "unavailable"
                ? `— ${c.detail}`
                : c.outcome === "failed"
                  ? `— could not check: ${c.detail}`
                  : c.outcome === "not-asked"
                    ? "— not selected in settings"
                    : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="muted">
        For billing-grade figures install{" "}
        <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl("https://opencost.io/docs/installation/helm"))}>
          OpenCost
        </a>{" "}
        (needs Prometheus):
      </div>
      <pre className="mono cost-cmd">
        helm install opencost --repo https://opencost.github.io/opencost-helm-chart opencost --namespace opencost --create-namespace
      </pre>
      <div className="muted">
        Without one, Bens estimates costs from Prometheus (kube-state-metrics and cAdvisor series) — check the{" "}
        <a href="#" onClick={(e) => (e.preventDefault(), onOpenSettings("metrics"))}>
          Prometheus settings
        </a>
        . A backend installed under other labels can be set in the{" "}
        <a href="#" onClick={(e) => (e.preventDefault(), onOpenSettings("cost"))}>
          cost settings
        </a>
        .
      </div>
      <div>
        <button onClick={onCheckAgain}>Check again</button>
      </div>
    </div>
  );
}

function Detected({
  conn,
  prefs,
  detection,
  window,
  setWindow,
  idle,
  setIdle,
  onNavigate,
  onOpenSettings,
}: {
  conn: Connection;
  prefs: ClusterPrefs;
  detection: Extract<Detection, { status: "detected" }>;
  window: CostWindow;
  setWindow: (w: CostWindow) => void;
  idle: boolean;
  setIdle: (v: boolean) => void;
  onNavigate: Props["onNavigate"];
  onOpenSettings: (s: string) => void;
}) {
  const { source } = detection;
  const estimated = source.estimated;
  const nodesKey = conn.resources.find((r) => navId(r) === "/nodes")?.key;
  // Node labels and sizes price the estimate (spot, Arm); the backends price nodes themselves.
  const nodes = useWatch(estimated ? nodesKey : undefined, null);

  const capi = useApi();
  const observations = usePolled<Observations | null>(estimated ? window : null, () => loadObservations(capi, window));
  const backend = usePolled<CostAllocation | null>(estimated ? null : window, () => fetchBackendAllocation(capi, source, window));
  // The stepped request is the slowest by far: the figures don't wait for it.
  const backendTrend = usePolled<CostTrend | null>(estimated ? null : window, () => fetchBackendTrend(capi, source, window));

  const rates = ratesFrom(prefs);
  const estimate_ = useMemo(
    () => (estimated && observations.data ? estimate(observations.data, nodes.items, rates) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estimated, observations.data, nodes.items, rates.cpu, rates.ram, rates.spotDiscount, rates.currency],
  );

  const fetched = (estimated ? estimate_?.allocation : backend.data) ?? undefined;
  const trend = estimated ? estimate_?.trend : backendTrend.data;
  const error = estimated ? observations.error : backend.error;
  const loading = estimated ? observations.loading : backend.loading;
  const allocation = fetched ? (idle ? fetched : withoutIdle(fetched)) : undefined;
  const stale = allocation && allocation.window !== window;

  return (
    <>
      <Strip allocation={allocation} raw={fetched} estimated={estimated} sourceName={source.name} handle={source.handle} />
      <div className="cost-controls">
        <div className="seg">
          {COST_WINDOWS.map((w) => (
            <button key={w} className={w === window ? "on" : ""} onClick={() => setWindow(w)}>
              {w === "24h" ? "Last 24 hours" : w === "7d" ? "Last 7 days" : "Last 30 days"}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={idle} onChange={(e) => setIdle(e.target.checked)} />
          <span>Include idle</span>
        </label>
        {(loading || stale) && <RefreshCw size={14} className="spin muted" />}
        <div className="spacer" />
        {estimated && (
          <a href="#" className="small" onClick={(e) => (e.preventDefault(), onOpenSettings("cost"))}>
            Rates: {formatRate(rates.cpu, rates.currency)}/core·h, {formatRate(rates.ram, rates.currency)}/GiB·h
          </a>
        )}
      </div>
      {error && !fetched && <div className="banner bad">{error}</div>}
      {!fetched && !error && <div className="panel muted">Loading costs…</div>}
      {allocation && allocation.namespaces.length === 0 && (
        <div className="panel muted">
          {source.name} has no usage for this window yet.
          {estimated ? " The estimate needs at least one whole hour of Prometheus data." : " A freshly installed backend needs some time to collect data."}
        </div>
      )}
      {allocation && allocation.namespaces.length > 0 && (
        <>
          <div className="panel">
            <h4>Cost over time</h4>
            <TrendChart allocation={allocation} trend={trend && trend.window === allocation.window ? trend : undefined} idle={idle} />
          </div>
          <div className="panel">
            <h4>Cost by namespace ({allocation.namespaces.filter((n) => !n.isIdle).length})</h4>
            <NamespaceTable allocation={allocation} estimated={estimated} onNavigate={onNavigate} />
          </div>
        </>
      )}
    </>
  );
}

function Strip({
  allocation,
  raw,
  estimated,
  sourceName,
  handle,
}: {
  allocation?: CostAllocation;
  raw?: CostAllocation;
  estimated: boolean;
  sourceName: string;
  handle: string;
}) {
  const cur = allocation?.currency ?? "USD";
  const idle = raw?.namespaces.find((n) => n.isIdle);
  const idleShare = idle && raw!.totalCost > 0 ? idle.totalCost / raw!.totalCost : undefined;
  const eff = raw?.efficiency;
  const nsCount = allocation?.namespaces.filter((n) => !n.isIdle).length;
  return (
    <div className="stats cost-strip">
      <div className="stat">
        <div className="stat-value">{allocation ? formatMoney(allocation.totalCost, cur) : "—"}</div>
        <div className="muted small">Total cost</div>
      </div>
      {idle && idleShare !== undefined && (
        <div className="stat" title="Cluster capacity no workload requested">
          <div className={`stat-value ${idleShare >= 0.5 ? "bad" : idleShare >= 0.2 ? "warn" : "ok"}`}>
            {formatMoney(idle.totalCost, cur)} · {Math.round(idleShare * 100)}%
          </div>
          <div className="muted small">Idle</div>
        </div>
      )}
      {eff?.cpu !== undefined && (
        <div className="stat" title="Cluster-wide CPU usage against requests">
          <div className={`stat-value ${efficiencyTone(eff.cpu, false)}`}>{formatEfficiency(eff.cpu)}</div>
          <div className="muted small">CPU efficiency</div>
        </div>
      )}
      {eff?.ram !== undefined && (
        <div
          className="stat"
          title={
            eff.ram >= 1.2
              ? "Workloads use more memory than they request: a risk of eviction rather than a cost to trim"
              : "Cluster-wide memory usage against requests"
          }
        >
          <div className={`stat-value ${efficiencyTone(eff.ram, true)}`}>{formatEfficiency(eff.ram)}</div>
          <div className="muted small">Memory efficiency</div>
        </div>
      )}
      <div className="stat">
        <div className="stat-value">{nsCount ?? "—"}</div>
        <div className="muted small">Namespaces</div>
      </div>
      <div className="stat" title={estimated ? ESTIMATE_NOTE : handle}>
        <div className="stat-value small-value">{sourceName}</div>
        <div className="muted small">{estimated ? "estimated at list rates" : handle}</div>
      </div>
    </div>
  );
}

const W = 800;
const H = 220;
const PAD = { l: 64, r: 8, t: 8, b: 22 };

function bucketLabel(t: number, step: string) {
  const d = new Date(t);
  return step === "1h"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Stacked bars per bucket, one color per segment; the share bar alone while the trend loads. */
function TrendChart({ allocation, trend, idle }: { allocation: CostAllocation; trend?: CostTrend; idle: boolean }) {
  const segs = segments(allocation);
  const named = new Set(segs.filter((s) => s.kind === "namespace").map((s) => s.namespaces[0]));
  const valueOf = (seg: Segment, costs: Record<string, number>) =>
    seg.kind === "other"
      ? Object.entries(costs).reduce((sum, [n, c]) => (n !== IDLE && !named.has(n) ? sum + c : sum), 0)
      : seg.namespaces.reduce((sum, n) => sum + (costs[n] ?? 0), 0);
  const cur = allocation.currency;
  const buckets = trend?.buckets ?? [];
  const stacks = buckets.map((b) => segs.map((s) => (s.kind === "idle" && !idle ? 0 : valueOf(s, b.costByNamespace))));
  const max = Math.max(...stacks.map((s) => s.reduce((a, b) => a + b, 0)), 0) * 1.1 || 1;
  const bw = (W - PAD.l - PAD.r) / Math.max(buckets.length, 1);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const labelEvery = Math.ceil(buckets.length / 8);

  return (
    <div className="cost-trend">
      <div className="share-bar">
        {segs.map((s) => (
          <span key={s.label} style={{ width: `${s.share * 100}%`, background: s.color }} title={`${s.label}: ${formatMoney(s.cost, cur)}`} />
        ))}
      </div>
      {buckets.length > 0 ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Cost over time">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
              <text x={PAD.l - 6} y={y(max * f) + 3} textAnchor="end" className="axis">
                {formatMoney(max * f, cur)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            let acc = 0;
            const total = stacks[i].reduce((a, v) => a + v, 0);
            return (
              <g key={b.startedAt}>
                <title>
                  {`${new Date(b.startedAt).toLocaleString()}\n${formatMoney(total, cur)}\n` +
                    segs.map((s, j) => (stacks[i][j] > 0 ? `${s.label}: ${formatMoney(stacks[i][j], cur)}` : "")).filter(Boolean).join("\n")}
                </title>
                {segs.map((s, j) => {
                  const v = stacks[i][j];
                  if (v <= 0) return null;
                  const y0 = y(acc);
                  acc += v;
                  return <rect key={s.label} x={PAD.l + i * bw + bw * 0.12} width={bw * 0.76} y={y(acc)} height={Math.max(0, y0 - y(acc))} fill={s.color} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={PAD.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" className="axis">
                    {bucketLabel(b.startedAt, trend!.step)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="muted small chart-empty">{trend ? "No per-bucket data for this window." : "Loading the trend…"}</div>
      )}
      <div className="cost-legend">
        {segs.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label} <b>{formatMoney(s.cost, cur)}</b> <span className="muted">{(s.share * 100).toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

type SortKey = "namespace" | "cpuCost" | "ramCost" | "pvCost" | "networkCost" | "totalCost" | "efficiency";

function NamespaceTable({
  allocation,
  estimated,
  onNavigate,
}: {
  allocation: CostAllocation;
  estimated: boolean;
  onNavigate: Props["onNavigate"];
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "totalCost", desc: true });
  const cur = allocation.currency;
  // The estimate prices cores and memory only; storage and network columns would be all zeros.
  const cols: { key: SortKey; title: string }[] = [
    { key: "namespace", title: "Namespace" },
    { key: "cpuCost", title: "CPU" },
    { key: "ramCost", title: "Memory" },
    ...(estimated
      ? []
      : ([
          { key: "pvCost", title: "Storage" },
          { key: "networkCost", title: "Network" },
        ] as const)),
    { key: "totalCost", title: "Total" },
    { key: "efficiency", title: "Efficiency" },
  ];
  const grid = `minmax(200px, 2fr) repeat(${cols.length - 1}, minmax(90px, 1fr))`;
  const label = (n: NamespaceCost) => (n.isIdle ? "Idle (unused capacity)" : n.namespace);
  const rows = [...allocation.namespaces].sort((a, b) => {
    const va = sort.key === "namespace" ? label(a) : (a[sort.key] ?? -1);
    const vb = sort.key === "namespace" ? label(b) : (b[sort.key] ?? -1);
    const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sort.desc ? -c : c;
  });

  return (
    <div className="table plain">
      <div className="tr th" style={{ gridTemplateColumns: grid }}>
        {cols.map((c) => (
          <div
            key={c.key}
            className="td"
            onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== "namespace" }))}
          >
            {c.title}
            {sort.key === c.key && <span className="sort">{sort.desc ? "▼" : "▲"}</span>}
          </div>
        ))}
      </div>
      {rows.map((n) => (
        <div
          key={n.namespace}
          className="tr"
          style={{ gridTemplateColumns: grid, cursor: n.isIdle ? "default" : undefined }}
          onClick={unlessSelecting(() => !n.isIdle && onNavigate("/namespaces", undefined, { name: n.namespace }))}
          title={n.isIdle ? "Cluster capacity that no workload requested, so it cannot be attributed to a namespace" : undefined}
        >
          <div className={`td ${n.isIdle ? "muted" : ""}`}>{label(n)}</div>
          {cols.slice(1).map((c) =>
            c.key === "efficiency" ? (
              <div
                key={c.key}
                className="td"
                title={
                  n.efficiency === undefined
                    ? n.isIdle
                      ? undefined
                      : "No value: this namespace requests no CPU or memory"
                    : `CPU efficiency: ${formatEfficiency(n.cpuEfficiency)}\nMemory efficiency: ${formatEfficiency(n.ramEfficiency)}`
                }
              >
                {formatEfficiency(n.efficiency)}
              </div>
            ) : (
              <div key={c.key} className={`td ${c.key === "totalCost" ? "strong" : ""}`}>
                {formatMoney(n[c.key] as number, cur)}
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
