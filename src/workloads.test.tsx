import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Connection, KubeObject, ResourceInfo } from "./api";
import { ClusterContext } from "./clusterContext";
import { WorkloadsOverview } from "./components/WorkloadsOverview";
import { liveWatches, obj } from "./test/tauriMock";
import { countStates, podState, podStatesByOwner, workloadState } from "./workloads";

const owned = (kind: string, uid: string) => ({ ownerReferences: [{ apiVersion: "apps/v1", kind, name: uid, uid, controller: true }] });
const pod = (name: string, status: any, owner?: string): KubeObject => ({
  metadata: { name, uid: `uid-${name}`, ...(owner ? owned("ReplicaSet", owner) : {}) },
  status,
});
const running = (name: string, owner?: string) =>
  pod(name, { phase: "Running", containerStatuses: [{ name: "app", ready: true, state: { running: {} } }] }, owner);
const crashing = (name: string, owner?: string) =>
  pod(name, { phase: "Running", containerStatuses: [{ name: "app", ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } }] }, owner);

describe("pod states", () => {
  it("counts problems while running or starting as failed", () => {
    expect(podState(running("a"))).toBe("Running");
    expect(podState(crashing("b"))).toBe("Failed");
    expect(podState(pod("c", { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }] }))).toBe("Pending");
    expect(podState(pod("d", { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] }))).toBe("Failed");
    expect(podState(pod("e", { phase: "Succeeded" }))).toBe("Succeeded");
    expect(podState({ ...running("f"), metadata: { name: "f", deletionTimestamp: "2026-01-01T00:00:00Z" } })).toBe("Terminating");
  });
});

describe("workload states", () => {
  it("fails a Deployment when a pod of its ReplicaSet fails", () => {
    const rs = { metadata: { name: "api-1", uid: "rs-1", ...owned("Deployment", "dep-api") } };
    const owners = podStatesByOwner([running("api-a", "rs-1"), crashing("api-b", "rs-1")], [rs]);
    const deployment = { metadata: { name: "api", uid: "dep-api" }, spec: { replicas: 2 }, status: { readyReplicas: 1 } };
    expect(workloadState("Deployment", deployment, owners.get("dep-api"))).toBe("Failed");
    expect(workloadState("ReplicaSet", { ...rs, spec: { replicas: 2 }, status: { readyReplicas: 1 } }, owners.get("rs-1"))).toBe("Failed");
  });

  it("is pending until all replicas are ready, and scaled down at zero", () => {
    expect(workloadState("StatefulSet", obj("db", { spec: { replicas: 3 }, status: { readyReplicas: 2 } }))).toBe("Pending");
    expect(workloadState("StatefulSet", obj("db", { spec: { replicas: 3 }, status: { readyReplicas: 3 } }))).toBe("Running");
    expect(workloadState("DaemonSet", obj("ds", { status: { desiredNumberScheduled: 4, numberReady: 3 } }))).toBe("Pending");
    expect(workloadState("ReplicaSet", obj("old", { spec: { replicas: 0 } }))).toBe("Scaled down");
  });

  it("reads Jobs from their conditions and CronJobs from suspend", () => {
    const job = (status: any, spec: any = {}) => workloadState("Job", obj("job", { spec, status }));
    expect(job({ conditions: [{ type: "Complete", status: "True" }] })).toBe("Succeeded");
    expect(job({ conditions: [{ type: "Failed", status: "True" }] })).toBe("Failed");
    expect(job({ active: 1 })).toBe("Running");
    expect(job({}, { suspend: true })).toBe("Suspended");
    expect(workloadState("CronJob", obj("cj", { spec: { suspend: true } }))).toBe("Suspended");
    expect(workloadState("CronJob", obj("cj", { spec: {} }))).toBe("Scheduled");
  });

  it("counts states in legend order", () => {
    expect(countStates(["Failed", "Running", "Pending", "Running"])).toEqual([
      ["Running", 2],
      ["Pending", 1],
      ["Failed", 1],
    ]);
  });
});

const R = (group: string, kind: string, plural: string): ResourceInfo => ({
  key: `${group}/v1/${plural}`,
  group,
  version: "v1",
  kind,
  plural,
  namespaced: true,
});
const conn: Connection = {
  context: "c",
  serverVersion: "v1.33",
  defaultNamespace: "default",
  metrics: false,
  resources: [R("", "Pod", "pods"), R("apps", "Deployment", "deployments"), R("apps", "ReplicaSet", "replicasets"), R("", "Event", "events")],
};

describe("workloads overview", () => {
  it("charts each kind the cluster serves and links events to their objects", async () => {
    const onNavigate = vi.fn();
    render(
      <ClusterContext.Provider value="c">
        <WorkloadsOverview conn={conn} namespace="web" onNavigate={onNavigate} />
      </ClusterContext.Provider>,
    );
    await waitFor(() => expect(liveWatches("/v1/events")).toHaveLength(1));
    expect(liveWatches("/v1/pods")[0].namespace).toBe("web");
    act(() => {
      liveWatches("/v1/pods")[0].channel.send({ type: "reset", items: [running("a"), running("b"), crashing("c")] });
      liveWatches("/v1/events")[0].channel.send({
        type: "reset",
        items: [
          obj("ev", {
            type: "Warning",
            reason: "BackOff",
            message: "Back-off restarting failed container",
            involvedObject: { apiVersion: "v1", kind: "Pod", name: "c", namespace: "web" },
          }),
        ],
      });
    });

    // Only the kinds in `conn` get a chart.
    expect(await screen.findByText("Pods (3)")).toBeTruthy();
    expect(screen.getByText("Deployments (0)")).toBeTruthy();
    expect(screen.queryByText(/Daemon Sets/)).toBeNull();
    const legend = screen.getByText("Pods (3)").closest(".wo-card")!.querySelector(".ring-legend")!;
    expect([...legend.children].map((d) => d.textContent?.trim())).toEqual(["Running: 2", "Failed: 1"]);

    fireEvent.click(screen.getByText("Pod/c"));
    expect(onNavigate).toHaveBeenCalledWith("/pods", undefined, { namespace: "web", name: "c" });
    fireEvent.click(screen.getByText("Pods (3)"));
    expect(onNavigate).toHaveBeenLastCalledWith("/pods");
  });
});
