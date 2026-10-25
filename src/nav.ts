import type { ResourceInfo } from "./api";
import { argoResources, fluxResources, isArgo, isFlux } from "./gitops";

/** Views that are not a Kubernetes resource list. */
export const OVERVIEW = "overview";
export const PORT_FORWARDS = "portforwards";
export const HELM = "helm";
export const FLUX = "flux";
export const ARGO = "argo";
export const COST = "cost";
export const WORKLOADS_OVERVIEW = "workloads";
export const SPECIAL_VIEWS: Record<string, string> = {
  [OVERVIEW]: "Overview",
  [WORKLOADS_OVERVIEW]: "Overview",
  [PORT_FORWARDS]: "Port Forwarding",
  [HELM]: "Releases",
  [FLUX]: "Flux",
  [ARGO]: "Argo CD",
  [COST]: "Cost Monitoring",
};

/** Navigator tree node: a view (`id`) or a group of children. */
export interface NavNode {
  key: string;
  label: string;
  /** View id to open; groups without one only expand. */
  id?: string;
  /** Icon key from icons.tsx (top-level nodes only). */
  icon?: string;
  children?: NavNode[];
}

/** The cluster menu. Entries are `group/plural`; missing ones are hidden. */
const GROUPS: { title: string; icon: string; items: string[] }[] = [
  {
    title: "Workloads",
    icon: "workloads",
    items: [
      WORKLOADS_OVERVIEW,
      "/pods",
      "apps/deployments",
      "apps/daemonsets",
      "apps/statefulsets",
      "apps/replicasets",
      "/replicationcontrollers",
      "batch/jobs",
      "batch/cronjobs",
    ],
  },
  {
    title: "Config",
    icon: "config",
    items: [
      "/configmaps",
      "/secrets",
      "/resourcequotas",
      "/limitranges",
      "autoscaling/horizontalpodautoscalers",
      "policy/poddisruptionbudgets",
      "scheduling.k8s.io/priorityclasses",
      "node.k8s.io/runtimeclasses",
      "coordination.k8s.io/leases",
      "admissionregistration.k8s.io/mutatingwebhookconfigurations",
      "admissionregistration.k8s.io/validatingwebhookconfigurations",
    ],
  },
  {
    title: "Network",
    icon: "network",
    items: [
      "/services",
      "/endpoints",
      "networking.k8s.io/ingresses",
      "networking.k8s.io/ingressclasses",
      "networking.k8s.io/networkpolicies",
      PORT_FORWARDS,
    ],
  },
  {
    title: "Storage",
    icon: "storage",
    items: ["/persistentvolumeclaims", "/persistentvolumes", "storage.k8s.io/storageclasses"],
  },
  {
    // Dynamic Resource Allocation (GPUs and other devices), shown when the cluster serves resource.k8s.io.
    title: "Device Resources",
    icon: "devices",
    items: [
      "resource.k8s.io/resourceclaims",
      "resource.k8s.io/resourceclaimtemplates",
      "resource.k8s.io/deviceclasses",
      "resource.k8s.io/resourceslices",
    ],
  },
];

const ACCESS = [
  "/serviceaccounts",
  "rbac.authorization.k8s.io/clusterroles",
  "rbac.authorization.k8s.io/roles",
  "rbac.authorization.k8s.io/clusterrolebindings",
  "rbac.authorization.k8s.io/rolebindings",
];

const BUILTIN_GROUP = /^(|apps|batch|autoscaling|policy|networking\.k8s\.io|storage\.k8s\.io|rbac\.authorization\.k8s\.io|scheduling\.k8s\.io|admissionregistration\.k8s\.io|apiextensions\.k8s\.io|apiregistration\.k8s\.io|coordination\.k8s\.io|discovery\.k8s\.io|events\.k8s\.io|flowcontrol\.apiserver\.k8s\.io|node\.k8s\.io|certificates\.k8s\.io|resource\.k8s\.io|internal\.apiserver\.k8s\.io|storagemigration\.k8s\.io)$/;

export const navId = (r: ResourceInfo) => `${r.group}/${r.plural}`;

/** The resource of an object's `apiVersion` and `kind` (owner references, events' objects). */
export const findResource = (resources: ResourceInfo[], apiVersion: string | undefined, kind: string | undefined) => {
  const group = apiVersion?.includes("/") ? apiVersion.split("/")[0] : "";
  return resources.find((r) => r.group === group && r.kind === kind);
};

/** Navigator tree for a connected cluster, in menu order. */
export function buildNavTree(resources: ResourceInfo[]): NavNode[] {
  const byId = new Map(resources.map((r) => [navId(r), r]));
  const leaf = (id: string): NavNode | null => {
    if (id in SPECIAL_VIEWS) return { key: id, id, label: SPECIAL_VIEWS[id] };
    const r = byId.get(id);
    return r ? { key: id, id, label: pluralTitle(r) } : null;
  };
  const top = (id: string, icon: string): NavNode[] => {
    const n = leaf(id);
    return n ? [{ ...n, icon }] : [];
  };
  const group = (title: string, icon: string, items: (NavNode | null)[]): NavNode[] => {
    const children = items.filter((n): n is NavNode => !!n);
    return children.length ? [{ key: `g:${title}`, label: title, icon, children }] : [];
  };
  const kinds = (list: ResourceInfo[]) => list.map((r) => ({ key: navId(r), id: navId(r), label: pluralTitle(r) }));

  const flux = fluxResources(resources);
  const argo = argoResources(resources);
  const custom = new Map<string, ResourceInfo[]>();
  for (const r of resources) {
    if (BUILTIN_GROUP.test(r.group) || isFlux(r) || isArgo(r)) continue;
    custom.set(r.group, [...(custom.get(r.group) ?? []), r]);
  }

  return [
    ...top(OVERVIEW, "overview"),
    ...top(COST, "cost"),
    ...(flux.length ? group("Flux", "flux", [{ key: FLUX, id: FLUX, label: "Dashboard" }, ...kinds(flux)]) : []),
    ...(argo.length ? group("Argo CD", "argo", [{ key: ARGO, id: ARGO, label: "Dashboard" }, ...kinds(argo)]) : []),
    ...top("/nodes", "nodes"),
    ...GROUPS.flatMap((g) => group(g.title, g.icon, g.items.map(leaf))),
    ...top("/namespaces", "namespaces"),
    ...top("/events", "events"),
    ...group("Helm", "helm", [leaf(HELM)]),
    ...group("Access Control", "access", ACCESS.map(leaf)),
    ...group(
      "Custom Resources",
      "custom",
      [...custom.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([g, items]) => ({ key: `crd:${g}`, label: g, children: kinds(items) })),
    ),
  ];
}

/** Keys of the groups that contain a view, to expand the path to it. */
export function pathTo(tree: NavNode[], id: string, path: string[] = []): string[] | null {
  for (const n of tree) {
    if (n.id === id) return path;
    if (n.children) {
      const p = pathTo(n.children, id, [...path, n.key]);
      if (p) return p;
    }
  }
  return null;
}

/** "PersistentVolumeClaim" -> "Persistent Volume Claims" */
export function pluralTitle(r: ResourceInfo): string {
  const words = r.kind.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  if (/[^aeiou]y$/.test(words)) return words.slice(0, -1) + "ies";
  if (/(ss|x|ch|sh)$/.test(words)) return words + "es";
  // Kinds already in the plural (Endpoints) stay as they are.
  if (/s$/.test(words)) return words;
  return words + "s";
}

/** Tab / title label of a view. */
export function viewTitle(id: string, resources: ResourceInfo[]): string {
  if (id === HELM) return "Helm Releases";
  if (id === WORKLOADS_OVERVIEW) return "Workloads Overview";
  if (id === FLUX || id === ARGO) return `${SPECIAL_VIEWS[id]} dashboard`;
  if (id in SPECIAL_VIEWS) return SPECIAL_VIEWS[id];
  const r = resources.find((x) => navId(x) === id);
  return r ? pluralTitle(r) : id;
}
