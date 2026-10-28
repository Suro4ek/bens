import { describe, expect, it } from "vitest";
import type { KubeObject } from "./api";
import { duration, pullingSince, PullSpeeds } from "./pulls";

const ev = (reason: string, at: string, fieldPath = "spec.containers{api}"): KubeObject => ({
  metadata: { name: `${reason}-${at}` },
  reason,
  lastTimestamp: at,
  involvedObject: { kind: "Pod", fieldPath },
});

describe("pullingSince", () => {
  it("is the time of a Pulling event nothing has followed", () => {
    const events = [ev("Scheduled", "2026-10-25T10:00:00Z", ""), ev("Pulling", "2026-10-25T10:00:01Z")];
    expect(pullingSince(events, "api")).toBe("2026-10-25T10:00:01Z");
  });

  it("ends with the pull, even within the same second", () => {
    expect(pullingSince([ev("Pulling", "2026-10-25T10:00:01Z"), ev("Pulled", "2026-10-25T10:00:09Z")], "api")).toBeUndefined();
    expect(pullingSince([ev("Failed", "2026-10-25T10:00:01Z"), ev("Pulling", "2026-10-25T10:00:01Z")], "api")).toBeUndefined();
  });

  it("starts again when the kubelet retries", () => {
    const events = [ev("Pulling", "2026-10-25T10:05:00Z"), ev("Failed", "2026-10-25T10:01:00Z"), ev("BackOff", "2026-10-25T10:02:00Z")];
    expect(pullingSince(events, "api")).toBe("2026-10-25T10:05:00Z");
  });

  it("tells containers and init containers apart", () => {
    const events = [ev("Pulling", "2026-10-25T10:00:01Z", "spec.initContainers{api}")];
    expect(pullingSince(events, "api")).toBeUndefined();
    expect(pullingSince(events, "api", true)).toBe("2026-10-25T10:00:01Z");
  });
});

describe("duration", () => {
  it("formats minutes and hours", () => {
    expect(duration(5)).toBe("0:05");
    expect(duration(65.4)).toBe("1:05");
    expect(duration(3600 * 2 + 7)).toBe("2:00:07");
  });
});

describe("PullSpeeds", () => {
  it("smooths the speed of each image between readings", () => {
    const speeds = new PullSpeeds();
    const pull = (done: number) => [{ manifest: "m", done, total: 1000, layers: 1, layersDone: 0 }];
    expect(speeds.update(pull(0), 0)).toEqual({});
    expect(speeds.update(pull(200), 2000)).toEqual({ m: 100 });
    expect(speeds.update(pull(600), 4000)).toEqual({ m: 140 });
  });
});
