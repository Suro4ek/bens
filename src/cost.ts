//! Cost monitoring: figures from OpenCost or Kubecost when the
//! cluster runs one, otherwise estimated from Prometheus usage and node sizes.

import { api, KubeObject, PromSeries } from "./api";
import type { ClusterPrefs } from "./prefs";
import { parseQuantity } from "./util";

export type CostWindow = "24h" | "7d" | "30d";
export const COST_WINDOWS: CostWindow[] = ["24h", "7d", "30d"];
export type TrendStep = "1h" | "1d";
export const stepFor: Record<CostWindow, TrendStep> = { "24h": "1h", "7d": "1d", "30d": "1d" };

/** Pseudo-namespace the backends use for unallocated cluster capacity. */
export const IDLE = "__idle__";

export interface NamespaceCost {
  namespace: string;
  cpuCost: number;
  ramCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  /** Usage against requests; undefined when nothing is requested (backends report a misleading 0 or 1 then). */
  efficiency?: number;
  cpuEfficiency?: number;
  ramEfficiency?: number;
  isIdle?: boolean;
}

export interface CostAllocation {
  window: CostWindow;
  currency: string;
  /** Includes idle, as the backends' own UIs count it. */
  totalCost: number;
  namespaces: NamespaceCost[];
  /** Cluster-wide, from the backend's own aggregate (a ratio of sums, not of the per-namespace ratios). */
  efficiency?: { cpu?: number; ram?: number };
}

export interface CostTrend {
  window: CostWindow;
  step: TrendStep;
  /** Oldest first. */
  buckets: { startedAt: number; costByNamespace: Record<string, number> }[];
}

export type CostSourceId = "kubecost" | "opencost" | "estimated";

export interface CostSource {
  id: CostSourceId;
  name: string;
  /** Where it was found: a service address, or "prometheus" for the estimate. */
  handle: string;
  estimated: boolean;
}

export type Detection =
  | { status: "detected"; source: CostSource; candidates: Candidate[] }
  | { status: "not-detected"; candidates: Candidate[] }
  | { status: "off"; candidates: Candidate[] }
  | { status: "failed"; error: string; candidates: Candidate[] };

export interface Candidate {
  id: CostSourceId;
  name: string;
  outcome: "available" | "unavailable" | "failed" | "not-asked";
  detail?: string;
}

interface Backend {
  id: "kubecost" | "opencost";
  name: string;
  selectors: string[];
  port: number;
  path: string;
}

// Kubecost first: it bundles OpenCost's engine, and a fixed order keeps the source from flapping.
export const BACKENDS: Backend[] = [
  {
    id: "kubecost",
    name: "Kubecost",
    selectors: ["app.kubernetes.io/name=cost-analyzer", "app=cost-analyzer"],
    port: 9090,
    path: "/model/allocation",
  },
  {
    id: "opencost",
    name: "OpenCost",
    selectors: ["app.kubernetes.io/name=opencost", "app=opencost"],
    port: 9003,
    path: "/allocation/compute",
  },
];

export const SOURCE_NAMES: Record<CostSourceId, string> = {
  kubecost: "Kubecost",
  opencost: "OpenCost",
  estimated: "Estimate",
};

export const ESTIMATE_NOTE =
  "Estimated from the cluster's own usage at list rates. Reservations, discounts, storage, egress and load balancers are not in it, so it will not match the bill. For billing-grade figures install OpenCost or Kubecost.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether Prometheus has kube-state-metrics' request series — the one thing the estimate cannot do without. */
async function detectEstimate(): Promise<string | { why: string }> {
  const prom = await api.prometheusDetect();
  if (!prom) return { why: "Prometheus not found" };
  const end = Math.floor(Date.now() / 1000);
  const series = await api.prometheusRange('count(kube_pod_container_resource_requests{resource="cpu"})', end - 600, end, 60);
  return series.some((s) => s.values.length > 0) ? "prometheus" : { why: "no kube-state-metrics data in Prometheus" };
}

/** Finds the cluster's cost source per its settings: the first available in order, or the one chosen. */
export async function detectCostSource(prefs: ClusterPrefs): Promise<Detection> {
  const pref = prefs.costSource ?? "auto";
  const all: CostSourceId[] = ["kubecost", "opencost", "estimated"];
  const notAsked = (id: CostSourceId): Candidate => ({ id, name: SOURCE_NAMES[id], outcome: "not-asked" });
  if (pref === "off") return { status: "off", candidates: all.map(notAsked) };

  const asked = pref === "auto" ? all : all.filter((id) => id === pref);
  const address = prefs.costAddress?.trim();
  if (pref !== "auto" && pref !== "estimated" && address) {
    const source = { id: pref, name: SOURCE_NAMES[pref], handle: address, estimated: false };
    return { status: "detected", source, candidates: all.map((id) => (id === pref ? { ...notAsked(id), outcome: "available", detail: address } : notAsked(id))) };
  }

  const results = await Promise.all(
    asked.map(async (id): Promise<[CostSourceId, string | { why: string } | Error]> => {
      try {
        if (id === "estimated") return [id, await detectEstimate()];
        const b = BACKENDS.find((x) => x.id === id)!;
        return [id, (await api.costFindService(b.selectors, b.port)) ?? { why: "not installed" }];
      } catch (e) {
        return [id, new Error(message(e))];
      }
    }),
  );
  const candidates = all.map((id): Candidate => {
    const r = results.find(([x]) => x === id);
    if (!r) return notAsked(id);
    const [, v] = r;
    if (v instanceof Error) return { id, name: SOURCE_NAMES[id], outcome: "failed", detail: v.message };
    return typeof v === "string"
      ? { id, name: SOURCE_NAMES[id], outcome: "available", detail: v }
      : { id, name: SOURCE_NAMES[id], outcome: "unavailable", detail: v.why };
  });
  for (const [id, v] of results) {
    if (typeof v === "string") {
      return { status: "detected", source: { id, name: SOURCE_NAMES[id], handle: v, estimated: id === "estimated" }, candidates };
    }
  }
  const failed = results.find(([, v]) => v instanceof Error);
  if (failed) return { status: "failed", error: (failed[1] as Error).message, candidates };
  return { status: "not-detected", candidates };
}

// --- OpenCost / Kubecost -----------------------------------------------------

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const whenRequested = (eff: unknown, requested: unknown) => (num(requested) > 0 ? optNum(eff) : undefined);

/**
 * Allocation sets of a response: OpenCost and Kubecost v1 put them straight in
 * `data`, Kubecost v2's aggregator in `data.sets[].allocations`. Empty sets
 * (`{}` / `null`) are kept, a gap is information too.
 */
export function allocationSets(response: unknown): { allocations: Rec; window?: Rec }[] | undefined {
  const data = asRec(response)?.data;
  if (Array.isArray(data)) return data.map((s) => ({ allocations: asRec(s) ?? {} }));
  const sets = asRec(data)?.sets;
  if (Array.isArray(sets)) return sets.map((s) => ({ allocations: asRec(asRec(s)?.allocations) ?? {}, window: asRec(asRec(s)?.window) }));
  return undefined;
}

function toNamespaceCost(name: string, a: Rec): NamespaceCost {
  const isIdle = name === IDLE;
  const cpuEfficiency = isIdle ? undefined : whenRequested(a.cpuEfficiency, a.cpuCoreRequestAverage);
  const ramEfficiency = isIdle ? undefined : whenRequested(a.ramEfficiency, a.ramByteRequestAverage);
  return {
    namespace: name,
    cpuCost: num(a.cpuCost),
    ramCost: num(a.ramCost),
    pvCost: num(a.pvCost),
    networkCost: num(a.networkCost),
    totalCost: num(a.totalCost),
    efficiency: cpuEfficiency === undefined && ramEfficiency === undefined ? undefined : optNum(a.totalEfficiency),
    cpuEfficiency,
    ramEfficiency,
    ...(isIdle ? { isIdle: true } : {}),
  };
}

export function normalizeAllocation(response: unknown, window: CostWindow): CostAllocation {
  const sets = allocationSets(response);
  if (!sets) throw new Error("Unexpected allocation response from the cost backend");
  const byName = new Map<string, NamespaceCost>();
  for (const { allocations } of sets) {
    for (const [name, raw] of Object.entries(allocations)) {
      const a = asRec(raw);
      if (!a) continue;
      const cost = toNamespaceCost(name, a);
      const prev = byName.get(name);
      // Ratios cannot be summed: a namespace in several sets has no efficiency the backend vouches for.
      byName.set(
        name,
        prev
          ? {
              ...prev,
              cpuCost: prev.cpuCost + cost.cpuCost,
              ramCost: prev.ramCost + cost.ramCost,
              pvCost: prev.pvCost + cost.pvCost,
              networkCost: prev.networkCost + cost.networkCost,
              totalCost: prev.totalCost + cost.totalCost,
              efficiency: undefined,
              cpuEfficiency: undefined,
              ramEfficiency: undefined,
            }
          : cost,
      );
    }
  }
  const namespaces = [...byName.values()].sort((a, b) => b.totalCost - a.totalCost);
  return { window, currency: "USD", totalCost: namespaces.reduce((s, n) => s + n.totalCost, 0), namespaces };
}

/** Cluster-wide efficiency from an `aggregate=cluster` response (idle, listed first by Kubecost, skipped). */
export function normalizeClusterEfficiency(response: unknown): CostAllocation["efficiency"] {
  const clusters = allocationSets(response)?.[0]?.allocations ?? {};
  const c = asRec(Object.entries(clusters).find(([name]) => name !== IDLE)?.[1]);
  if (!c) return undefined;
  const cpu = whenRequested(c.cpuEfficiency, c.cpuCoreRequestAverage);
  const ram = whenRequested(c.ramEfficiency, c.ramByteRequestAverage);
  return cpu === undefined && ram === undefined ? undefined : { cpu, ram };
}

const STEP_MS: Record<TrendStep, number> = { "1h": 3600_000, "1d": 86400_000 };

export function normalizeTrend(response: unknown, window: CostWindow): CostTrend | undefined {
  const step = stepFor[window];
  const sets = allocationSets(response);
  if (!sets) return undefined;
  const parse = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);
  const rows = sets.map(({ allocations, window: w }) => {
    let startedAt: number | undefined;
    for (const a of Object.values(allocations)) {
      startedAt = parse(asRec(asRec(a)?.window)?.start);
      if (startedAt !== undefined) break;
    }
    startedAt ??= parse(w?.start);
    const costByNamespace = Object.fromEntries(Object.entries(allocations).map(([n, a]) => [n, num(asRec(a)?.totalCost)]));
    return { startedAt, costByNamespace };
  });
  // Empty buckets state no time of their own: step back from one that does.
  const anchor = rows.findIndex((r) => r.startedAt !== undefined);
  if (anchor === -1) return { window, step, buckets: [] };
  const t0 = rows[anchor].startedAt!;
  return {
    window,
    step,
    buckets: rows.map((r, i) => ({ startedAt: r.startedAt ?? t0 + (i - anchor) * STEP_MS[step], costByNamespace: r.costByNamespace })),
  };
}

export async function fetchBackendAllocation(source: CostSource, window: CostWindow): Promise<CostAllocation> {
  const b = BACKENDS.find((x) => x.id === source.id)!;
  const [byNs, byCluster] = await Promise.allSettled([
    api.serviceProxyGet(source.handle, b.path, { window, aggregate: "namespace", accumulate: "true", includeIdle: "true" }),
    api.serviceProxyGet(source.handle, b.path, { window, aggregate: "cluster", accumulate: "true" }),
  ]);
  if (byNs.status === "rejected") throw new Error(`Failed to request allocation from ${b.name}: ${message(byNs.reason)}`);
  const allocation = normalizeAllocation(byNs.value, window);
  // Best effort: a missing summary never costs the breakdown.
  if (byCluster.status === "fulfilled") allocation.efficiency = normalizeClusterEfficiency(byCluster.value);
  return allocation;
}

export async function fetchBackendTrend(source: CostSource, window: CostWindow): Promise<CostTrend> {
  const b = BACKENDS.find((x) => x.id === source.id)!;
  const res = await api.serviceProxyGet(source.handle, b.path, {
    window,
    aggregate: "namespace",
    accumulate: "false",
    step: stepFor[window],
    includeIdle: "true",
  });
  const trend = normalizeTrend(res, window);
  if (!trend) throw new Error(`${b.name} returned no per-bucket costs for the ${window} window.`);
  return trend;
}

// --- Estimate ------------------------------------------------------------------

const WINDOW_S: Record<CostWindow, number> = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
const STEP_S: Record<TrendStep, number> = { "1h": 3600, "1d": 86400 };
const GIB = 1024 ** 3;

/** OpenCost's defaults (GCP N1 on-demand, us-central1), so figures don't jump if OpenCost is installed later. */
export const DEFAULT_RATES = { cpu: 0.031611, ram: 0.004237, spotDiscount: 1 - 0.006655 / 0.031611, currency: "USD" };
const ARM_DISCOUNT = 0.2;

/** One sample per step, aligned to whole steps; the unfinished step is left out. */
function rangeFor(window: CostWindow, nowMs: number) {
  const step = STEP_S[stepFor[window]];
  const end = Math.floor(nowMs / 1000 / step) * step;
  return { start: end - (WINDOW_S[window] / step - 1) * step, end, step };
}

/**
 * Series the estimate is built from, per namespace and node, averaged over each
 * step and weighted by how much of the step the thing existed.
 * Usage comes from cAdvisor with the node joined in from kube_pod_info, so the
 * spelling of cAdvisor's node label never matters.
 */
function estimateQueries(step: TrendStep) {
  const podNode = `topk by (namespace, pod) (1, last_over_time(kube_pod_info[${step}]))`;
  const byPodNode = `* on (namespace, pod) group_left(node) (${podNode})`;
  const containers = `container!="", container!="POD"`;
  const podCgroup = `container="", pod!=""`;
  const perPod = (usage: (sel: string) => string) =>
    `(sum by (namespace, pod) (${usage(containers)}) or sum by (namespace, pod) (${usage(podCgroup)}))`;
  const running = "kube_pod_container_status_running";
  const runningShare = `max by (namespace, pod, container, uid) (sum_over_time(${running}[${step}]) / scalar(max(count_over_time(${running}[${step}]))))`;
  const requests = (resource: string) => {
    const sel = `kube_pod_container_resource_requests{resource="${resource}", container!=""}`;
    return `sum by (namespace, node) (avg by (namespace, pod, container, uid, node) (avg_over_time(${sel}[${step}])) * on (namespace, pod, container, uid) group_left() ${runningShare})`;
  };
  const presentAverage = (sel: string) => `sum_over_time(${sel}[${step}]) / scalar(max(count_over_time(${sel}[${step}])))`;
  return {
    cpuRequests: requests("cpu"),
    ramRequests: requests("memory"),
    cpuUsage: `sum by (namespace, node) (${perPod((s) => `rate(container_cpu_usage_seconds_total{${s}}[${step}])`)} ${byPodNode})`,
    ramUsage: `sum by (namespace, node) (${perPod((s) => presentAverage(`container_memory_working_set_bytes{${s}}`))} ${byPodNode})`,
    cpuCapacity: `max by (node) (avg_over_time(kube_node_status_capacity{resource="cpu"}[${step}]))`,
    ramCapacity: `max by (node) (avg_over_time(kube_node_status_capacity{resource="memory"}[${step}]))`,
  };
}

type SeriesSet = Record<keyof ReturnType<typeof estimateQueries>, PromSeries[]>;

export interface Observations {
  window: CostWindow;
  step: TrendStep;
  buckets: {
    startedAt: number;
    hours: number;
    usage: { namespace: string; node: string; cpuReq: number; cpuUse: number; ramReq: number; ramUse: number }[];
    capacity: { node: string; cpu: number; ram: number }[];
  }[];
}

const observationCache = new Map<string, { end: number; data: Promise<Observations> }>();
export const resetCostCache = () => observationCache.clear();

/** Reads usage for a window from Prometheus; kept while the aligned range stays the same. */
export function loadObservations(clusterId: string, window: CostWindow): Promise<Observations> {
  const range = rangeFor(window, Date.now());
  const key = `${clusterId}|${window}`;
  const kept = observationCache.get(key);
  if (kept && kept.end === range.end) return kept.data;
  const step = stepFor[window];
  const q = estimateQueries(step);
  const run = (query: string) => api.prometheusRange(query, range.start, range.end, range.step);
  const names = Object.keys(q) as (keyof typeof q)[];
  const data = Promise.all([
    ...names.map((n) => run(q[n])),
    // When Prometheus began recording: a step it recorded only part of is charged for that part.
    run("min(prometheus_tsdb_lowest_timestamp_seconds)").then(
      (s) => s.flatMap((x) => x.values.map((v) => v[1])).at(-1),
      () => undefined,
    ),
  ]).then((res) => {
    const series = Object.fromEntries(names.map((n, i) => [n, res[i] as PromSeries[]])) as SeriesSet;
    return toObservations(window, range, series, res[names.length] as number | undefined);
  });
  observationCache.set(key, { end: range.end, data });
  data.catch(() => observationCache.get(key)?.data === data && observationCache.delete(key));
  return data;
}

function toObservations(window: CostWindow, range: { start: number; end: number; step: number }, s: SeriesSet, since?: number): Observations {
  const index = (series: PromSeries[], labels: string[]) => {
    const m = new Map<string, Map<number, number>>();
    for (const { metric, values } of series) {
      const k = labels.map((l) => metric[l] ?? "").join("\n");
      const byT = m.get(k) ?? new Map<number, number>();
      for (const [t, v] of values) byT.set(t, v);
      m.set(k, byT);
    }
    return m;
  };
  const at = (m: Map<string, Map<number, number>>, k: string, t: number) => m.get(k)?.get(t) ?? 0;
  const ul = ["namespace", "node"];
  const cpuReq = index(s.cpuRequests, ul), cpuUse = index(s.cpuUsage, ul), ramReq = index(s.ramRequests, ul), ramUse = index(s.ramUsage, ul);
  const cpuCap = index(s.cpuCapacity, ["node"]), ramCap = index(s.ramCapacity, ["node"]);
  const usageKeys = new Set([...cpuReq.keys(), ...cpuUse.keys(), ...ramReq.keys(), ...ramUse.keys()]);
  const nodeKeys = new Set([...cpuCap.keys(), ...ramCap.keys()]);
  const buckets: Observations["buckets"] = [];
  for (let t = range.start; t <= range.end; t += range.step) {
    const from = Math.max(t - range.step, since ?? -Infinity);
    const usage = [...usageKeys].flatMap((k) => {
      const [namespace = "", node = ""] = k.split("\n");
      const o = { namespace, node, cpuReq: at(cpuReq, k, t), cpuUse: at(cpuUse, k, t), ramReq: at(ramReq, k, t), ramUse: at(ramUse, k, t) };
      return o.cpuReq || o.cpuUse || o.ramReq || o.ramUse ? [o] : [];
    });
    const capacity = [...nodeKeys].flatMap((node) => {
      const c = { node, cpu: at(cpuCap, node, t), ram: at(ramCap, node, t) };
      return c.cpu || c.ram ? [c] : [];
    });
    buckets.push({ startedAt: (t - range.step) * 1000, hours: Math.max(0, t - from) / 3600, usage, capacity });
  }
  return { window, step: stepFor[window], buckets };
}

export interface Rates {
  cpu: number;
  ram: number;
  spotDiscount: number;
  currency: string;
}

export const ratesFrom = (p: ClusterPrefs): Rates => ({
  cpu: p.costCpuRate ?? DEFAULT_RATES.cpu,
  ram: p.costRamRate ?? DEFAULT_RATES.ram,
  spotDiscount: p.costSpotDiscount ?? DEFAULT_RATES.spotDiscount,
  currency: p.costCurrency?.trim().toUpperCase() || DEFAULT_RATES.currency,
});

/** Labels clouds and autoscalers put on spot / preemptible nodes. */
const SPOT_LABELS: [string, string][] = [
  ["karpenter.sh/capacity-type", "spot"],
  ["eks.amazonaws.com/capacityType", "SPOT"],
  ["cloud.google.com/gke-spot", "true"],
  ["cloud.google.com/gke-preemptible", "true"],
  ["kubernetes.azure.com/scalesetpriority", "spot"],
  ["node.kubernetes.io/instance-lifecycle", "spot"],
  ["yandex.cloud/preemptible", "true"],
];

export const isSpotNode = (n: KubeObject) => SPOT_LABELS.some(([k, v]) => n.metadata.labels?.[k] === v);
const isArmNode = (n: KubeObject) => (n.metadata.labels?.["kubernetes.io/arch"] ?? n.status?.nodeInfo?.architecture) === "arm64";

/** Per-node rates: the base rates, discounted for spot and Arm nodes. */
export function nodeRates(node: KubeObject | undefined, rates: Rates) {
  const k = (node && isSpotNode(node) ? 1 - rates.spotDiscount : 1) * (node && isArmNode(node) ? 1 - ARM_DISCOUNT : 1);
  return { cpu: rates.cpu * k, ram: rates.ram * k };
}

/** Hourly price of a node at the given rates. */
export function nodeHourly(node: KubeObject, rates: Rates) {
  const r = nodeRates(node, rates);
  return parseQuantity(node.status?.capacity?.cpu) * r.cpu + (parseQuantity(node.status?.capacity?.memory) / GIB) * r.ram;
}

/**
 * Prices what was observed the way OpenCost does without a billing export:
 * each namespace pays, per bucket and node, for the larger of what it requested
 * and used; capacity nobody requested or used is idle. Storage and network are
 * not priced — nothing in the cluster says what they cost.
 */
export function estimate(obs: Observations, nodes: KubeObject[], rates: Rates): { allocation: CostAllocation; trend: CostTrend } {
  const byName = new Map(nodes.map((n) => [n.metadata.name, n]));
  const rateCache = new Map<string, { cpu: number; ram: number }>();
  const rateOf = (node: string) => {
    let r = rateCache.get(node);
    if (!r) rateCache.set(node, (r = nodeRates(byName.get(node), rates)));
    return r;
  };
  type Tally = { cpuCost: number; ramCost: number; cpuReqH: number; cpuUseH: number; ramReqH: number; ramUseH: number };
  const tally = (): Tally => ({ cpuCost: 0, ramCost: 0, cpuReqH: 0, cpuUseH: 0, ramReqH: 0, ramUseH: 0 });
  const tallies = new Map<string, Tally>();
  const cluster = tally();
  let idleCpu = 0;
  let idleRam = 0;
  const buckets: CostTrend["buckets"] = [];

  for (const b of obs.buckets) {
    const allocated = new Map<string, { cpu: number; ram: number }>();
    const costByNamespace: Record<string, number> = {};
    for (const u of b.usage) {
      const r = rateOf(u.node);
      const cpu = Math.max(u.cpuReq, u.cpuUse);
      const ram = Math.max(u.ramReq, u.ramUse);
      const cpuCost = cpu * r.cpu * b.hours;
      const ramCost = (ram / GIB) * r.ram * b.hours;
      const t = tallies.get(u.namespace) ?? tally();
      tallies.set(u.namespace, t);
      for (const x of [t, cluster]) {
        x.cpuCost += cpuCost;
        x.ramCost += ramCost;
        x.cpuReqH += u.cpuReq * b.hours;
        x.cpuUseH += u.cpuUse * b.hours;
        x.ramReqH += u.ramReq * b.hours;
        x.ramUseH += u.ramUse * b.hours;
      }
      costByNamespace[u.namespace] = (costByNamespace[u.namespace] ?? 0) + cpuCost + ramCost;
      const a = allocated.get(u.node) ?? { cpu: 0, ram: 0 };
      a.cpu += cpu;
      a.ram += ram;
      allocated.set(u.node, a);
    }
    let bIdle = 0;
    for (const c of b.capacity) {
      const r = rateOf(c.node);
      const a = allocated.get(c.node) ?? { cpu: 0, ram: 0 };
      const ic = Math.max(0, c.cpu - a.cpu) * r.cpu * b.hours;
      const ir = (Math.max(0, c.ram - a.ram) / GIB) * r.ram * b.hours;
      idleCpu += ic;
      idleRam += ir;
      bIdle += ic + ir;
    }
    if (bIdle > 0) costByNamespace[IDLE] = bIdle;
    buckets.push({ startedAt: b.startedAt, costByNamespace });
  }

  const ratio = (use: number, req: number) => (req > 0 ? use / req : undefined);
  // Cost-weighted, like OpenCost's totalEfficiency.
  const weighted = (t: Tally, cpu?: number, ram?: number) => {
    const parts = [...(cpu === undefined ? [] : [[t.cpuCost, cpu]]), ...(ram === undefined ? [] : [[t.ramCost, ram]])];
    if (!parts.length) return undefined;
    const w = parts.reduce((s, [c]) => s + c, 0);
    return w > 0 ? parts.reduce((s, [c, v]) => s + (c / w) * v, 0) : (cpu ?? ram);
  };
  const namespaces: NamespaceCost[] = [...tallies].map(([namespace, t]) => {
    const cpuEfficiency = ratio(t.cpuUseH, t.cpuReqH);
    const ramEfficiency = ratio(t.ramUseH, t.ramReqH);
    return {
      namespace,
      cpuCost: t.cpuCost,
      ramCost: t.ramCost,
      pvCost: 0,
      networkCost: 0,
      totalCost: t.cpuCost + t.ramCost,
      efficiency: weighted(t, cpuEfficiency, ramEfficiency),
      cpuEfficiency,
      ramEfficiency,
    };
  });
  if (idleCpu + idleRam > 0) {
    namespaces.push({ namespace: IDLE, cpuCost: idleCpu, ramCost: idleRam, pvCost: 0, networkCost: 0, totalCost: idleCpu + idleRam, isIdle: true });
  }
  namespaces.sort((a, b) => b.totalCost - a.totalCost);
  const cpu = ratio(cluster.cpuUseH, cluster.cpuReqH);
  const ram = ratio(cluster.ramUseH, cluster.ramReqH);
  return {
    allocation: {
      window: obs.window,
      currency: rates.currency,
      totalCost: namespaces.reduce((s, n) => s + n.totalCost, 0),
      namespaces,
      efficiency: cpu === undefined && ram === undefined ? undefined : { cpu, ram },
    },
    trend: { window: obs.window, step: obs.step, buckets },
  };
}

// --- Presentation --------------------------------------------------------------

export function formatMoney(amount: number, currency: string): string {
  const tiny = amount > 0 && amount < 0.01;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(tiny ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : {}),
    }).format(amount);
  } catch {
    return `${amount.toFixed(tiny ? 4 : 2)} ${currency}`;
  }
}

/** A rate keeps its small digits: $0.031611/core·h, not $0.03. */
export function formatRate(rate: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumSignificantDigits: 4 }).format(rate);
  } catch {
    return `${+rate.toPrecision(4)} ${currency}`;
  }
}

export const formatEfficiency = (e?: number) => (e === undefined ? "—" : `${(e * 100).toFixed(1)}%`);

/** Allocation without the idle row, when idle is hidden. */
export function withoutIdle(a: CostAllocation): CostAllocation {
  const idle = a.namespaces.find((n) => n.isIdle);
  return idle ? { ...a, totalCost: a.totalCost - idle.totalCost, namespaces: a.namespaces.filter((n) => !n.isIdle) } : a;
}

/** Categorical hues, never cycled: namespaces past the last fold into "Other". */
const HUES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
export const IDLE_HUE = "#6b6b6b";
const OTHER_HUE = "#4a4a4a";

export interface Segment {
  label: string;
  cost: number;
  share: number;
  color: string;
  namespaces: string[];
  kind: "idle" | "namespace" | "other";
}

/** Idle first, then the biggest namespaces, then "Other". */
export function segments(a: CostAllocation): Segment[] {
  if (a.totalCost <= 0) return [];
  const idle = a.namespaces.find((n) => n.isIdle);
  const work = a.namespaces.filter((n) => !n.isIdle && n.totalCost > 0);
  const named = work.slice(0, HUES.length);
  const rest = work.slice(HUES.length);
  const restCost = rest.reduce((s, n) => s + n.totalCost, 0);
  const seg = (label: string, cost: number, color: string, kind: Segment["kind"], namespaces: string[]): Segment => ({
    label,
    cost,
    share: cost / a.totalCost,
    color,
    kind,
    namespaces,
  });
  return [
    ...(idle && idle.totalCost > 0 ? [seg("Idle", idle.totalCost, IDLE_HUE, "idle", [IDLE])] : []),
    ...named.map((n, i) => seg(n.namespace, n.totalCost, HUES[i], "namespace", [n.namespace])),
    ...(restCost > 0 ? [seg(`Other (${rest.length})`, restCost, OTHER_HUE, "other", rest.map((n) => n.namespace))] : []),
  ];
}

/** Tone of an efficiency figure: low means paid-for requests go unused; memory above 120% is an eviction risk. */
export function efficiencyTone(e: number, memory: boolean): "ok" | "warn" | "bad" {
  if (memory && e >= 1.2) return "warn";
  return e >= 0.6 ? "ok" : e >= 0.3 ? "warn" : "bad";
}
