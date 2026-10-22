import { describe, expect, it } from "vitest";
import type { KubeObject } from "./api";
import { formatBytes, formatCpu, parseQuantity, podReady, podRestarts, podStatus } from "./util";

const pod = (spec: any, status: any): KubeObject => ({ metadata: { name: "p" }, spec, status });

describe("podStatus", () => {
  it("treats a running native sidecar as done with init", () => {
    const p = pod(
      { initContainers: [{ name: "istio-init" }, { name: "istio-proxy", restartPolicy: "Always" }], containers: [{ name: "app" }] },
      {
        phase: "Running",
        conditions: [{ type: "Initialized", status: "True" }, { type: "Ready", status: "True" }],
        initContainerStatuses: [
          { name: "istio-init", state: { terminated: { exitCode: 0, reason: "Completed" } } },
          { name: "istio-proxy", started: true, ready: true, state: { running: {} } },
        ],
        containerStatuses: [{ name: "app", ready: true, state: { running: {} } }],
      },
    );
    expect(podStatus(p)).toBe("Running");
    expect(podReady(p)).toEqual([2, 2]);
  });

  it("shows init progress", () => {
    const p = pod(
      { initContainers: [{ name: "a" }, { name: "b" }], containers: [{ name: "app" }] },
      {
        phase: "Pending",
        initContainerStatuses: [{ name: "a", state: { terminated: { exitCode: 0 } } }, { name: "b", state: { running: {} } }],
        containerStatuses: [{ name: "app", state: { waiting: { reason: "PodInitializing" } } }],
      },
    );
    expect(podStatus(p)).toBe("Init:1/2");
  });

  it("shows the waiting reason of a crashing container", () => {
    const p = pod({ containers: [{ name: "app" }] }, { phase: "Running", containerStatuses: [{ name: "app", restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } }] });
    expect(podStatus(p)).toBe("CrashLoopBackOff");
    expect(podRestarts(p)).toBe(7);
  });

  it("shows Completed for a finished job pod", () => {
    const p = pod({ containers: [{ name: "app" }] }, { phase: "Succeeded", containerStatuses: [{ name: "app", state: { terminated: { exitCode: 0, reason: "Completed" } } }] });
    expect(podStatus(p)).toBe("Completed");
  });

  it("shows Terminating for a pod being deleted", () => {
    const p = { ...pod({ containers: [{ name: "app" }] }, { phase: "Running" }), metadata: { name: "p", deletionTimestamp: "2026-01-01T00:00:00Z" } };
    expect(podStatus(p)).toBe("Terminating");
  });
});

describe("quantities", () => {
  it("parses CPU and memory units", () => {
    expect(parseQuantity("250m")).toBeCloseTo(0.25);
    expect(parseQuantity("2")).toBe(2);
    expect(parseQuantity("512Mi")).toBe(512 * 2 ** 20);
    expect(parseQuantity("1G")).toBe(1e9);
    expect(parseQuantity(undefined)).toBe(0);
  });

  it("formats them back", () => {
    expect(formatCpu(0.25)).toBe("250m");
    expect(formatBytes(512 * 2 ** 20)).toMatch(/512(\.0)?Mi/);
  });
});
