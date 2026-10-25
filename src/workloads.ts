//! Workloads overview, like Lens': how many pods and workloads of each kind run, wait or fail.

import type { KubeObject } from "./api";
import { podStatus, statusTone } from "./util";

export type WorkloadState =
  | "Running"
  | "Scheduled"
  | "Succeeded"
  | "Pending"
  | "Suspended"
  | "Failed"
  | "Terminating"
  | "Scaled down"
  | "Unknown";

/** Legend order and colors. */
export const STATE_COLORS: Record<WorkloadState, string> = {
  Running: "var(--ok)",
  Scheduled: "var(--ok)",
  Succeeded: "var(--accent)",
  Pending: "var(--warn)",
  Suspended: "var(--muted)",
  Failed: "var(--bad)",
  Terminating: "var(--magenta)",
  "Scaled down": "var(--bg-4)",
  Unknown: "var(--muted)",
};

/** The kinds on the overview, in Lens' order. */
export const OVERVIEW_KINDS = [
  { id: "/pods", kind: "Pod" },
  { id: "apps/deployments", kind: "Deployment" },
  { id: "apps/daemonsets", kind: "DaemonSet" },
  { id: "apps/statefulsets", kind: "StatefulSet" },
  { id: "apps/replicasets", kind: "ReplicaSet" },
  { id: "batch/jobs", kind: "Job" },
  { id: "batch/cronjobs", kind: "CronJob" },
] as const;

/** A pod's phase; problems `kubectl get pods` shows while it runs or starts (CrashLoopBackOff, ImagePullBackOff…) count as failed. */
export function podState(pod: KubeObject): WorkloadState {
  if (pod.metadata.deletionTimestamp) return "Terminating";
  const phase = pod.status?.phase;
  if (phase === "Succeeded") return "Succeeded";
  if (phase === "Failed") return "Failed";
  if (phase !== "Running" && phase !== "Pending") return "Unknown";
  const status = podStatus(pod);
  if (statusTone(status) === "bad") return "Failed";
  return phase === "Running" && status === "Running" ? "Running" : "Pending";
}

/** Pods' states by the uid of their owner; a ReplicaSet's pods also count for its Deployment. */
export function podStatesByOwner(pods: KubeObject[], replicaSets: KubeObject[]): Map<string, WorkloadState[]> {
  const map = new Map<string, WorkloadState[]>();
  const add = (uid: string, states: WorkloadState[]) => {
    const list = map.get(uid);
    if (list) list.push(...states);
    else map.set(uid, [...states]);
  };
  for (const pod of pods) {
    const state = podState(pod);
    for (const owner of pod.metadata.ownerReferences ?? []) add(owner.uid, [state]);
  }
  for (const rs of replicaSets) {
    const states = map.get(rs.metadata.uid ?? "");
    if (states) for (const owner of rs.metadata.ownerReferences ?? []) add(owner.uid, states);
  }
  return map;
}

const hasCondition = (o: KubeObject, ...types: string[]) =>
  ((o.status?.conditions ?? []) as any[]).some((c) => types.includes(c.type) && c.status === "True");

/** Ready and desired replicas. */
function replicas(kind: string, o: KubeObject): [number, number] {
  if (kind === "DaemonSet") return [o.status?.numberReady ?? 0, o.status?.desiredNumberScheduled ?? 0];
  return [o.status?.readyReplicas ?? 0, o.spec?.replicas ?? 1];
}

/**
 * A workload's state from its own status and its pods (as Lens does): failed when one of its pods
 * fails, pending while pods start or not all replicas are ready, running otherwise.
 */
export function workloadState(kind: string, o: KubeObject, pods: WorkloadState[] = []): WorkloadState {
  if (kind === "Pod") return podState(o);
  if (o.metadata.deletionTimestamp) return "Terminating";
  if (kind === "CronJob") return o.spec?.suspend ? "Suspended" : "Scheduled";
  if (kind === "Job") {
    if (hasCondition(o, "Complete", "SuccessCriteriaMet")) return "Succeeded";
    if (hasCondition(o, "Failed", "FailureTarget")) return "Failed";
    if (o.spec?.suspend) return "Suspended";
    if (pods.length && pods.every((s) => s === "Pending")) return "Pending";
    return o.status?.active ? "Running" : "Pending";
  }
  const [ready, desired] = replicas(kind, o);
  if (desired === 0) return "Scaled down";
  if (pods.includes("Failed")) return "Failed";
  if (pods.includes("Pending") || ready < desired) return "Pending";
  return "Running";
}

/** How many are in each state, in legend order, without the empty ones. */
export function countStates(states: WorkloadState[]): [WorkloadState, number][] {
  const counts = new Map<WorkloadState, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  return (Object.keys(STATE_COLORS) as WorkloadState[]).filter((s) => counts.has(s)).map((s) => [s, counts.get(s)!]);
}
