//! Dynamic Resource Allocation (resource.k8s.io), shown as "Device Resources".
//! Reads v1 and the older beta shapes: v1beta1 requests carry the class
//! directly instead of under `exactly`, and its devices nest under `basic`.

import type { KubeObject } from "./api";

export const DRA_GROUP = "resource.k8s.io";
export const CLAIMS = `${DRA_GROUP}/resourceclaims`;
export const CLAIM_TEMPLATES = `${DRA_GROUP}/resourceclaimtemplates`;
export const DEVICE_CLASSES = `${DRA_GROUP}/deviceclasses`;
export const SLICES = `${DRA_GROUP}/resourceslices`;

export interface DeviceRequest {
  name: string;
  classes: string[];
  mode: string;
  selectors: string[];
  adminAccess: boolean;
}

/** Requests of a claim spec (`spec` of a ResourceClaim, `spec.spec` of a template). */
export function deviceRequests(spec: any): DeviceRequest[] {
  return ((spec?.devices?.requests ?? []) as any[]).map((r) => {
    const exact = r.exactly ?? (r.deviceClassName ? r : undefined);
    const alts: any[] = exact ? [exact] : (r.firstAvailable ?? []);
    const mode = (x: any) => (x.allocationMode === "All" ? "all" : `${x.count ?? 1}`);
    return {
      name: r.name,
      classes: alts.map((a) => a.deviceClassName),
      mode: exact ? mode(exact) : alts.map((a) => `${a.deviceClassName}×${mode(a)}`).join(" | "),
      selectors: alts.flatMap((a) => ((a.selectors ?? []) as any[]).map((s) => s.cel?.expression).filter(Boolean)),
      adminAccess: !!exact?.adminAccess,
    };
  });
}

/** Device classes a claim spec asks for; first-available requests contribute every alternative. */
export const requestedClasses = (spec: any): string[] => [...new Set(deviceRequests(spec).flatMap((r) => r.classes))];

export interface AllocatedDevice {
  request: string;
  driver: string;
  pool: string;
  device: string;
}

export const allocatedDevices = (claim: KubeObject): AllocatedDevice[] => claim.status?.allocation?.devices?.results ?? [];

export function claimState(claim: KubeObject): string {
  if (!claim.status?.allocation) return "Pending";
  const reserved = (claim.status?.reservedFor ?? []).length;
  return reserved ? `Allocated (reserved: ${reserved})` : "Allocated";
}

const NEGATIVE = /fail|error|unhealthy|degraded/i;

/**
 * First unhealthy driver-reported device condition: positive conditions (Ready,
 * Healthy…) are bad when False, negative ones (*Failed, *Error…) when True.
 */
export function claimProblem(claim: KubeObject): string | undefined {
  for (const d of (claim.status?.devices ?? []) as any[]) {
    const c = ((d.conditions ?? []) as any[]).find((c) => (NEGATIVE.test(c.type) ? c.status === "True" : c.status === "False"));
    if (c) return `Device ${d.device} (${d.driver}) reports ${c.type}=${c.status}${c.message ? `: ${c.message}` : ""}`;
  }
  return undefined;
}

export const deviceKey = (d: { driver: string; pool: string; device: string }) => `${d.driver}/${d.pool}/${d.device}`;

/** Which claim holds which device — a device is allocated exactly when some claim's allocation references it. */
export function allocationMap(claims: KubeObject[]): Map<string, { name: string; namespace: string }> {
  const m = new Map<string, { name: string; namespace: string }>();
  for (const c of claims) {
    for (const d of allocatedDevices(c)) {
      const k = deviceKey(d);
      if (!m.has(k)) m.set(k, { name: c.metadata.name, namespace: c.metadata.namespace ?? "" });
    }
  }
  return m;
}

export interface SliceDevice {
  name: string;
  attributes: [string, string][];
  capacity: [string, string][];
  taints: string[];
}

const attrValue = (a: any) => String(a?.string ?? a?.int ?? a?.bool ?? a?.version ?? "");

export function sliceDevices(slice: KubeObject): SliceDevice[] {
  return ((slice.spec?.devices ?? []) as any[]).map((d) => {
    const body = d.basic ?? d;
    return {
      name: d.name,
      attributes: Object.entries(body.attributes ?? {}).map(([k, v]) => [k, attrValue(v)] as [string, string]),
      capacity: Object.entries(body.capacity ?? {}).map(([k, v]: [string, any]) => [k, String(v?.value ?? v)] as [string, string]),
      taints: ((body.taints ?? []) as any[]).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`),
    };
  });
}

export const sliceNode = (slice: KubeObject): string =>
  slice.spec?.allNodes ? "All nodes" : (slice.spec?.nodeName ?? (slice.spec?.nodeSelector ? "Node selector" : ""));

export function allocatedInSlice(slice: KubeObject, map: Map<string, unknown>): number {
  const driver = slice.spec?.driver;
  const pool = slice.spec?.pool?.name;
  return sliceDevices(slice).filter((d) => map.has(deviceKey({ driver, pool, device: d.name }))).length;
}

/** Drivers a device class carries configuration for — the closest it has to a StorageClass provisioner. */
export const classDrivers = (dc: KubeObject): string =>
  [...new Set(((dc.spec?.config ?? []) as any[]).map((c) => c.opaque?.driver).filter(Boolean))].join(", ");

/** Name a pod-level claim entry resolves to: set directly, or generated from a template. */
export function podClaimNames(pod: KubeObject): { entry: string; claim?: string; template?: string }[] {
  const generated = new Map(((pod.status?.resourceClaimStatuses ?? []) as any[]).map((s) => [s.name, s.resourceClaimName]));
  return ((pod.spec?.resourceClaims ?? []) as any[]).map((c) => ({
    entry: c.name,
    claim: c.resourceClaimName ?? generated.get(c.name),
    template: c.resourceClaimTemplateName,
  }));
}

/** Containers of a pod that use a pod-level claim entry. */
export const containersUsingClaim = (pod: KubeObject, entry: string): string[] =>
  [...((pod.spec?.initContainers ?? []) as any[]), ...((pod.spec?.containers ?? []) as any[])]
    .filter((c) => ((c.resources?.claims ?? []) as any[]).some((x) => x.name === entry))
    .map((c) => c.name);
