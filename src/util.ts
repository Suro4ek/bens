import type { KubeObject } from "./api";

export function age(ts?: string): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.floor(d / 365)}y${d % 365}d`;
}

export const ageSeconds = (ts?: string) => (ts ? (Date.now() - Date.parse(ts)) / 1000 : 0);

/** Pod status the way `kubectl get pods` prints it. */
/** Init containers with `restartPolicy: Always` are sidecars that keep running (K8s 1.29+). */
const sidecarNames = (pod: KubeObject) =>
  new Set(((pod.spec?.initContainers ?? []) as any[]).filter((c) => c.restartPolicy === "Always").map((c) => c.name));

/** Pod status as `kubectl get pods` prints it. */
export function podStatus(pod: KubeObject): string {
  const status = pod.status ?? {};
  let reason: string = status.reason ?? status.phase ?? "Unknown";
  const sidecars = sidecarNames(pod);
  const conditions = (status.conditions ?? []) as any[];
  const initialized = conditions.some((c) => c.type === "Initialized" && c.status === "True");

  let initializing = false;
  const init = (status.initContainerStatuses ?? []) as any[];
  for (let i = 0; i < init.length; i++) {
    const c = init[i];
    // A started sidecar counts as done; it keeps running next to the app containers.
    if (sidecars.has(c.name) && c.started) continue;
    const t = c.state?.terminated;
    if (t && t.exitCode === 0) continue;
    const w = c.state?.waiting?.reason;
    if (t) reason = t.reason ? `Init:${t.reason}` : t.signal ? `Init:Signal:${t.signal}` : `Init:ExitCode:${t.exitCode}`;
    else if (w && w !== "PodInitializing") reason = `Init:${w}`;
    else reason = `Init:${i}/${(pod.spec?.initContainers ?? init).length}`;
    initializing = true;
    break;
  }

  if (!initializing || initialized) {
    let hasRunning = false;
    const cs = (status.containerStatuses ?? []) as any[];
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      const w = c.state?.waiting?.reason;
      const t = c.state?.terminated;
      if (w) reason = w;
      else if (t?.reason) reason = t.reason;
      else if (t) reason = t.signal ? `Signal:${t.signal}` : `ExitCode:${t.exitCode}`;
      else if (c.ready && c.state?.running) hasRunning = true;
    }
    // A finished container next to running ones doesn't make the pod "Completed".
    if (reason === "Completed" && hasRunning) {
      reason = conditions.some((c) => c.type === "Ready" && c.status === "True") ? "Running" : "NotReady";
    }
  }

  if (pod.metadata.deletionTimestamp) return status.reason === "NodeLost" ? "Unknown" : "Terminating";
  return reason;
}

/** Ready/total containers like kubectl: app containers plus sidecars. */
export function podReady(pod: KubeObject): [number, number] {
  const sidecars = sidecarNames(pod);
  const cs = (pod.status?.containerStatuses ?? []) as any[];
  const sc = ((pod.status?.initContainerStatuses ?? []) as any[]).filter((c) => sidecars.has(c.name));
  const total = (pod.spec?.containers ?? []).length + sidecars.size;
  return [cs.filter((c) => c.ready).length + sc.filter((c) => c.ready).length, total];
}

export const podRestarts = (pod: KubeObject): number =>
  [...((pod.status?.containerStatuses ?? []) as any[]), ...((pod.status?.initContainerStatuses ?? []) as any[])].reduce(
    (n, c) => n + (c.restartCount ?? 0),
    0,
  );

export function statusTone(s: string): "ok" | "warn" | "bad" | "muted" {
  if (/^(Running|Succeeded|Completed|Active|Ready|Bound|True|Normal|Available|Synced|Healthy|deployed)$/.test(s)) return "ok";
  if (/^(Pending|ContainerCreating|PodInitializing|Terminating|Init:\d|OutOfSync|Progressing|Reconciling|Suspended|pending)/.test(s)) return "warn";
  if (/(Err|BackOff|Fail|fail|Unknown|NotReady|Warning|Lost|OOM|Evicted|Invalid|Signal|ExitCode|Degraded|Missing|Stalled)/.test(s)) return "bad";
  return "muted";
}

export function nodeStatus(node: KubeObject): string {
  const ready = ((node.status?.conditions ?? []) as any[]).find((c) => c.type === "Ready");
  let s = ready?.status === "True" ? "Ready" : "NotReady";
  if (node.spec?.unschedulable) s += ",SchedulingDisabled";
  return s;
}

export const nodeRoles = (node: KubeObject): string =>
  Object.keys(node.metadata.labels ?? {})
    .filter((l) => l.startsWith("node-role.kubernetes.io/"))
    .map((l) => l.slice("node-role.kubernetes.io/".length))
    .join(",") || "<none>";

export function hashColor(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Parses a Kubernetes quantity ("250m", "1.5Gi", "128974848", "1e3") into a number of base units. */
export function parseQuantity(q?: string | number): number {
  if (q === undefined || q === null) return 0;
  if (typeof q === "number") return q;
  const m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(q.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return n * (BIN[m[2]] ?? DEC[m[2]] ?? 1);
}

export function formatCpu(cores: number): string {
  if (!cores) return "0";
  return cores < 1 ? `${Math.round(cores * 1000)}m` : `${cores.toFixed(cores < 10 ? 2 : 1)}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0";
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(bytes < 10 && i ? 1 : 0)}${units[i]}`;
}
