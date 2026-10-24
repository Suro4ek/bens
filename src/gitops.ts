import { api, ClusterApi, KubeObject, ResourceInfo } from "./api";
import { navId } from "./nav";

// ---------- Flux ----------

export const isFlux = (r: ResourceInfo) => r.group.endsWith(".toolkit.fluxcd.io");

/** Display order for Flux kinds; unknown Flux kinds are appended. */
const FLUX_ORDER = [
  "kustomize.toolkit.fluxcd.io/kustomizations",
  "helm.toolkit.fluxcd.io/helmreleases",
  "source.toolkit.fluxcd.io/gitrepositories",
  "source.toolkit.fluxcd.io/ocirepositories",
  "source.toolkit.fluxcd.io/helmrepositories",
  "source.toolkit.fluxcd.io/helmcharts",
  "source.toolkit.fluxcd.io/buckets",
  "source.toolkit.fluxcd.io/externalartifacts",
  "image.toolkit.fluxcd.io/imagerepositories",
  "image.toolkit.fluxcd.io/imagepolicies",
  "image.toolkit.fluxcd.io/imageupdateautomations",
  "notification.toolkit.fluxcd.io/alerts",
  "notification.toolkit.fluxcd.io/providers",
  "notification.toolkit.fluxcd.io/receivers",
];

const byOrder = (order: string[]) => (a: ResourceInfo, b: ResourceInfo) => {
  const ia = order.indexOf(navId(a));
  const ib = order.indexOf(navId(b));
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.kind.localeCompare(b.kind);
};

export const fluxResources = (all: ResourceInfo[]) => all.filter(isFlux).sort(byOrder(FLUX_ORDER));

const condition = (o: KubeObject, type: string) =>
  ((o.status?.conditions ?? []) as any[]).find((c) => c.type === type);

export type FluxState = "Ready" | "Failed" | "Reconciling" | "Suspended" | "Stalled" | "Unknown";

export function fluxState(o: KubeObject): FluxState {
  if (o.spec?.suspend) return "Suspended";
  if (condition(o, "Stalled")?.status === "True") return "Stalled";
  if (condition(o, "Reconciling")?.status === "True") return "Reconciling";
  const ready = condition(o, "Ready");
  if (ready?.status === "True") return "Ready";
  if (ready?.status === "False") return "Failed";
  // Some kinds (alerts, providers in v1beta3) have no status at all.
  return o.status?.conditions ? "Unknown" : "Ready";
}

export const fluxMessage = (o: KubeObject): string =>
  condition(o, "Stalled")?.message ?? condition(o, "Ready")?.message ?? "";

export const fluxRevision = (o: KubeObject): string =>
  o.status?.lastAppliedRevision ?? o.status?.artifact?.revision ?? o.status?.lastAttemptedRevision ?? "";

export const fluxSource = (o: KubeObject): string => {
  const ref = o.spec?.sourceRef ?? o.spec?.chart?.spec?.sourceRef ?? o.spec?.chartRef;
  if (ref) return `${ref.kind}/${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;
  return o.spec?.url ?? o.spec?.image ?? "";
};

export const fluxNeedsAttention = (o: KubeObject) => /^(Failed|Stalled)$/.test(fluxState(o));

/** `flux reconcile`: bumps the requestedAt annotation. */
export const fluxReconcile = (capi: ClusterApi, r: ResourceInfo, o: KubeObject) =>
  capi.patch(r.key, o.metadata.namespace, o.metadata.name, {
    metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": new Date().toISOString() } },
  });

export const fluxSuspend = (capi: ClusterApi, r: ResourceInfo, o: KubeObject, suspend: boolean) =>
  capi.patch(r.key, o.metadata.namespace, o.metadata.name, { spec: { suspend } });

/** Source object a Kustomization/HelmRelease reconciles from, for `--with-source`. */
export function fluxSourceTarget(all: ResourceInfo[], o: KubeObject): { res: ResourceInfo; obj: KubeObject } | null {
  const ref = o.spec?.sourceRef ?? o.spec?.chart?.spec?.sourceRef ?? o.spec?.chartRef;
  if (!ref) return null;
  const res = all.find((r) => isFlux(r) && r.kind === ref.kind && r.group.startsWith("source."));
  if (!res) return null;
  return {
    res,
    obj: { metadata: { name: ref.name, namespace: ref.namespace ?? o.metadata.namespace } } as KubeObject,
  };
}

// ---------- Argo CD ----------

export const isArgo = (r: ResourceInfo) => r.group === "argoproj.io";

const ARGO_ORDER = ["argoproj.io/applications", "argoproj.io/applicationsets", "argoproj.io/appprojects"];
export const argoResources = (all: ResourceInfo[]) => all.filter(isArgo).sort(byOrder(ARGO_ORDER));

export const argoSync = (o: KubeObject): string => o.status?.sync?.status ?? "Unknown";
export const argoHealth = (o: KubeObject): string => o.status?.health?.status ?? "Unknown";
export const argoOperation = (o: KubeObject): string => o.status?.operationState?.phase ?? "";

export const argoSource = (o: KubeObject): any => o.spec?.source ?? o.spec?.sources?.[0] ?? {};
export const argoSourceText = (o: KubeObject): string => {
  const s = argoSource(o);
  return [s.repoURL, s.path ?? s.chart].filter(Boolean).join(" · ");
};
export const argoDestination = (o: KubeObject): string => {
  const d = o.spec?.destination ?? {};
  return `${d.name ?? d.server ?? ""}${d.namespace ? ` / ${d.namespace}` : ""}`;
};

export const argoNeedsAttention = (o: KubeObject) =>
  argoSync(o) === "OutOfSync" ||
  /^(Degraded|Missing|Unknown)$/.test(argoHealth(o)) ||
  /^(Failed|Error)$/.test(argoOperation(o));

/** Same operation Argo CD's UI/CLI writes; the application controller executes it. */
export const argoSyncApp = (capi: ClusterApi, r: ResourceInfo, o: KubeObject, prune: boolean) =>
  capi.patch(r.key, o.metadata.namespace, o.metadata.name, {
    operation: {
      initiatedBy: { username: "bens" },
      sync: { revision: argoSource(o).targetRevision, prune, syncStrategy: { hook: {} } },
    },
  });

export const argoRefresh = (capi: ClusterApi, r: ResourceInfo, o: KubeObject, hard: boolean) =>
  capi.patch(r.key, o.metadata.namespace, o.metadata.name, {
    metadata: { annotations: { "argocd.argoproj.io/refresh": hard ? "hard" : "normal" } },
  });

/** Port-forwards argocd-server (in the Application's namespace by default) and opens it. */
export async function openArgoUi(capi: ClusterApi, namespace: string) {
  const f = await capi.portForwardStart("service", namespace, "argocd-server", 443, undefined, "https");
  await api.openUrl(`https://localhost:${f.localPort}`);
  return f;
}
