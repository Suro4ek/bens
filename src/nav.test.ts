import { describe, expect, it } from "vitest";
import type { ResourceInfo } from "./api";
import { buildNavTree, COST, OVERVIEW, pathTo, pluralTitle, viewTitle } from "./nav";

const R = (group: string, kind: string, plural: string): ResourceInfo => ({ key: `${group}/v1/${plural}`, group, version: "v1", kind, plural, namespaced: true });

describe("nav", () => {
  it("pluralizes kinds into titles", () => {
    expect(pluralTitle(R("", "PersistentVolumeClaim", "persistentvolumeclaims"))).toBe("Persistent Volume Claims");
    expect(pluralTitle(R("networking.k8s.io", "IngressClass", "ingressclasses"))).toBe("Ingress Classes");
    expect(pluralTitle(R("", "Policy", "policies"))).toBe("Policies");
  });

  it("builds the tree with only the resources the cluster serves", () => {
    const tree = buildNavTree([R("", "Pod", "pods"), R("apps", "Deployment", "deployments"), R("example.com", "Widget", "widgets")]);
    const labels = tree.map((n) => n.label);
    expect(labels.slice(0, 2)).toEqual(["Overview", "Cost Monitoring"]);
    expect(labels).toContain("Workloads");
    expect(labels).not.toContain("Device Resources");
    expect(tree.find((n) => n.label === "Workloads")!.children!.map((c) => c.label)).toEqual(["Pods", "Deployments"]);
    expect(labels).toContain("Custom Resources");
    expect(pathTo(tree, "example.com/widgets")).toEqual(["g:Custom Resources", "crd:example.com"]);
  });

  it("shows Device Resources when resource.k8s.io is served", () => {
    const tree = buildNavTree([R("resource.k8s.io", "ResourceClaim", "resourceclaims"), R("resource.k8s.io", "ResourceSlice", "resourceslices")]);
    const dra = tree.find((n) => n.label === "Device Resources");
    expect(dra?.children?.map((c) => c.label)).toEqual(["Resource Claims", "Resource Slices"]);
    // Built-in group: not listed again under custom resources.
    expect(tree.find((n) => n.label === "Custom Resources")).toBeUndefined();
  });

  it("titles special views", () => {
    expect(viewTitle(OVERVIEW, [])).toBe("Overview");
    expect(viewTitle(COST, [])).toBe("Cost Monitoring");
  });
});
