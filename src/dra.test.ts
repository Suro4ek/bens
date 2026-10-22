import { describe, expect, it } from "vitest";
import type { KubeObject } from "./api";
import { allocatedInSlice, allocationMap, claimProblem, claimState, containersUsingClaim, deviceRequests, podClaimNames, requestedClasses, sliceDevices, sliceNode } from "./dra";

const o = (extra: any): KubeObject => ({ metadata: { name: "x", namespace: "ns" }, ...extra });

describe("dra", () => {
  it("reads requests in the v1 and v1beta1 shapes", () => {
    const v1 = { devices: { requests: [{ name: "gpu", exactly: { deviceClassName: "gpu.example.com", count: 2, selectors: [{ cel: { expression: "true" } }] } }] } };
    const beta = { devices: { requests: [{ name: "gpu", deviceClassName: "gpu.example.com", allocationMode: "All" }] } };
    expect(deviceRequests(v1)[0]).toMatchObject({ classes: ["gpu.example.com"], mode: "2", selectors: ["true"] });
    expect(deviceRequests(beta)[0]).toMatchObject({ classes: ["gpu.example.com"], mode: "all" });
    const alts = { devices: { requests: [{ name: "any", firstAvailable: [{ name: "a", deviceClassName: "big" }, { name: "b", deviceClassName: "small" }] }] } };
    expect(requestedClasses(alts)).toEqual(["big", "small"]);
  });

  it("derives claim state and device problems", () => {
    expect(claimState(o({ status: {} }))).toBe("Pending");
    const allocated = o({
      status: {
        allocation: { devices: { results: [{ request: "gpu", driver: "d", pool: "p", device: "gpu-0" }] } },
        reservedFor: [{ resource: "pods", name: "a", uid: "1" }],
        devices: [{ driver: "d", pool: "p", device: "gpu-0", conditions: [{ type: "Ready", status: "False", message: "fell off the bus" }] }],
      },
    });
    expect(claimState(allocated)).toBe("Allocated (reserved: 1)");
    expect(claimProblem(allocated)).toContain("fell off the bus");
  });

  it("maps allocated devices back to slices", () => {
    const claim = o({ status: { allocation: { devices: { results: [{ request: "gpu", driver: "d", pool: "node-1", device: "gpu-1" }] } } } });
    const slice = o({ spec: { driver: "d", pool: { name: "node-1" }, nodeName: "node-1", devices: [{ name: "gpu-0" }, { name: "gpu-1", basic: { attributes: { model: { string: "A100" } } } }] } });
    const map = allocationMap([claim]);
    expect(allocatedInSlice(slice, map)).toBe(1);
    expect(sliceNode(slice)).toBe("node-1");
    expect(sliceDevices(slice)[1].attributes).toEqual([["model", "A100"]]);
  });

  it("resolves a pod's claims, including ones generated from templates", () => {
    const pod = o({
      spec: { resourceClaims: [{ name: "gpu", resourceClaimTemplateName: "one-gpu" }], containers: [{ name: "app", resources: { claims: [{ name: "gpu" }] } }, { name: "sidecar" }] },
      status: { resourceClaimStatuses: [{ name: "gpu", resourceClaimName: "pod-gpu-abc" }] },
    });
    expect(podClaimNames(pod)).toEqual([{ entry: "gpu", claim: "pod-gpu-abc", template: "one-gpu" }]);
    expect(containersUsingClaim(pod, "gpu")).toEqual(["app"]);
  });
});
