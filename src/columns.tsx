import type { ReactNode } from "react";
import { api, KubeObject, ResourceInfo } from "./api";
import { ingressPoints, ingressRoutes } from "./ingress";
import { metricsKey, MetricsMap } from "./useMetrics";
import {
  argoDestination,
  argoHealth,
  argoOperation,
  argoSourceText,
  argoSync,
  fluxMessage,
  fluxRevision,
  fluxSource,
  fluxState,
  isFlux,
} from "./gitops";
import { CLAIM_TEMPLATES, CLAIMS, claimProblem, claimState, classDrivers, DEVICE_CLASSES, requestedClasses, SLICES, sliceDevices, sliceNode } from "./dra";
import {
  age,
  ageSeconds,
  formatBytes,
  formatCpu,
  nodeRoles,
  nodeStatus,
  parseQuantity,
  podReady,
  podRestarts,
  podStatus,
  statusTone,
} from "./util";

export interface Column {
  title: string;
  value: (o: KubeObject) => string | number;
  render?: (o: KubeObject) => ReactNode;
  width?: string;
}

/** Ingress routes as `url ⇢ backend` chips; the URL opens in the browser (like Lens' Rules column). */
export function IngressLinks({ ingress }: { ingress: KubeObject }) {
  return (
    <span className="chips nowrap">
      {ingressRoutes(ingress).map((r) => (
        <span key={`${r.url}|${r.backend}`} className="chip route">
          {r.link ? (
            <a
              href="#"
              title={`Open ${r.url}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                api.openUrl(r.url);
              }}
            >
              {r.url}
            </a>
          ) : (
            r.url
          )}{" "}
          ⇢ {r.backend}
        </span>
      ))}
    </span>
  );
}

export const Status = ({ text }: { text: string }) => <span className={`status ${statusTone(text)}`}>{text}</span>;

const name: Column = { title: "Name", value: (o) => o.metadata.name, width: "minmax(220px, 3fr)" };
const namespace: Column = { title: "Namespace", value: (o) => o.metadata.namespace ?? "" };
const ageCol: Column = {
  title: "Age",
  value: (o) => -ageSeconds(o.metadata.creationTimestamp),
  render: (o) => age(o.metadata.creationTimestamp),
  width: "80px",
};
const keys = (field: string): Column => ({
  title: "Keys",
  value: (o) => Object.keys(o[field] ?? {}).join(", "),
});
const ratio = (title: string, ready: (o: KubeObject) => number, total: (o: KubeObject) => number): Column => ({
  title,
  value: (o) => `${ready(o) ?? 0}/${total(o) ?? 0}`,
  render: (o) => {
    const r = ready(o) ?? 0;
    const t = total(o) ?? 0;
    return <span className={`status ${r === t ? "ok" : "warn"}`}>{`${r}/${t}`}</span>;
  },
});

/** State of one container as a "status brick". */
export function containerBrick(pod: KubeObject, name: string): { tone: string; text: string } {
  const all = [...((pod.status?.initContainerStatuses ?? []) as any[]), ...((pod.status?.containerStatuses ?? []) as any[])];
  const st = all.find((c) => c.name === name);
  const state = st?.state ?? {};
  if (state.running) return st.ready ? { tone: "ok", text: "running, ready" } : { tone: "warn", text: "running, not ready" };
  if (state.waiting) return { tone: "warn", text: `waiting: ${state.waiting.reason ?? "…"}` };
  if (state.terminated) {
    const t = state.terminated;
    return t.exitCode === 0
      ? { tone: "done", text: `terminated: ${t.reason ?? "Completed"}` }
      : { tone: "bad", text: `terminated: ${t.reason ?? "Error"} (exit code ${t.exitCode})` };
  }
  return { tone: "unknown", text: "no status yet" };
}

const allContainerNames = (pod: KubeObject): string[] => [
  ...((pod.spec?.initContainers ?? []) as any[]).map((c) => c.name),
  ...((pod.spec?.containers ?? []) as any[]).map((c) => c.name),
];

export const Brick = ({ pod, name }: { pod: KubeObject; name: string }) => {
  const b = containerBrick(pod, name);
  return <span className={`brick ${b.tone}`} title={`${name}: ${b.text}`} />;
};

const podContainers: Column = {
  title: "Containers",
  value: (o) => podReady(o)[0] / (podReady(o)[1] || 1),
  render: (o) => (
    <span className="bricks">
      {allContainerNames(o).map((n) => (
        <Brick key={n} pod={o} name={n} />
      ))}
    </span>
  ),
  width: "minmax(104px, 0.6fr)",
};

const ownerName = (o: KubeObject) => {
  const owner = o.metadata.ownerReferences?.find((r) => r.controller) ?? o.metadata.ownerReferences?.[0];
  return owner ? owner.kind : "";
};

const specific: Record<string, Column[]> = {
  "/pods": [
    { title: "Restarts", value: podRestarts, width: "80px" },
    { title: "Controlled By", value: ownerName, width: "minmax(100px, 0.8fr)" },
    { title: "Node", value: (o) => o.spec?.nodeName ?? "" },
    { title: "QoS", value: (o) => o.status?.qosClass ?? "", width: "100px" },
  ],
  "apps/deployments": [
    ratio("Pods", (o) => o.status?.readyReplicas, (o) => o.spec?.replicas),
    { title: "Up-to-date", value: (o) => o.status?.updatedReplicas ?? 0, width: "90px" },
    { title: "Available", value: (o) => o.status?.availableReplicas ?? 0, width: "90px" },
  ],
  "apps/statefulsets": [ratio("Pods", (o) => o.status?.readyReplicas, (o) => o.spec?.replicas)],
  "apps/replicasets": [
    { title: "Desired", value: (o) => o.spec?.replicas ?? 0 },
    { title: "Current", value: (o) => o.status?.replicas ?? 0 },
    { title: "Ready", value: (o) => o.status?.readyReplicas ?? 0 },
  ],
  "apps/daemonsets": [
    { title: "Desired", value: (o) => o.status?.desiredNumberScheduled ?? 0 },
    { title: "Current", value: (o) => o.status?.currentNumberScheduled ?? 0 },
    ratio("Ready", (o) => o.status?.numberReady, (o) => o.status?.desiredNumberScheduled),
  ],
  "batch/jobs": [
    ratio("Completions", (o) => o.status?.succeeded, (o) => o.spec?.completions ?? 1),
    {
      title: "Status",
      value: (o) => ((o.status?.conditions ?? []) as any[]).find((c) => c.status === "True")?.type ?? "Running",
      render: (o) => (
        <Status text={((o.status?.conditions ?? []) as any[]).find((c) => c.status === "True")?.type ?? "Running"} />
      ),
    },
  ],
  "batch/cronjobs": [
    { title: "Schedule", value: (o) => o.spec?.schedule ?? "" },
    { title: "Suspend", value: (o) => String(!!o.spec?.suspend) },
    { title: "Active", value: (o) => (o.status?.active ?? []).length },
    { title: "Last schedule", value: (o) => age(o.status?.lastScheduleTime) },
  ],
  "/services": [
    { title: "Type", value: (o) => o.spec?.type ?? "" },
    { title: "Cluster IP", value: (o) => o.spec?.clusterIP ?? "" },
    {
      title: "Ports",
      value: (o) =>
        ((o.spec?.ports ?? []) as any[])
          .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`)
          .join(", "),
    },
    {
      title: "External IP",
      value: (o) =>
        [
          ...((o.status?.loadBalancer?.ingress ?? []) as any[]).map((i) => i.ip ?? i.hostname),
          ...(o.spec?.externalIPs ?? []),
        ].join(", "),
    },
  ],
  "/nodes": [
    { title: "Status", value: nodeStatus, render: (o) => <Status text={nodeStatus(o)} /> },
    { title: "Roles", value: nodeRoles },
    { title: "Version", value: (o) => o.status?.nodeInfo?.kubeletVersion ?? "" },
    { title: "CPU", value: (o) => o.status?.capacity?.cpu ?? "", width: "70px" },
    { title: "Memory", value: (o) => o.status?.capacity?.memory ?? "" },
    {
      title: "Internal IP",
      value: (o) => ((o.status?.addresses ?? []) as any[]).find((a) => a.type === "InternalIP")?.address ?? "",
    },
  ],
  "/namespaces": [
    { title: "Status", value: (o) => o.status?.phase ?? "", render: (o) => <Status text={o.status?.phase ?? ""} /> },
  ],
  "/events": [
    { title: "Type", value: (o) => o.type ?? "", render: (o) => <Status text={o.type ?? ""} />, width: "90px" },
    { title: "Reason", value: (o) => o.reason ?? "" },
    { title: "Object", value: (o) => `${o.involvedObject?.kind}/${o.involvedObject?.name}` },
    { title: "Message", value: (o) => o.message ?? "", width: "minmax(260px, 4fr)" },
    { title: "Count", value: (o) => o.count ?? 1, width: "70px" },
    {
      title: "Last seen",
      value: (o) => -ageSeconds(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp),
      render: (o) => age(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp),
      width: "90px",
    },
  ],
  "/configmaps": [keys("data")],
  "/secrets": [{ title: "Type", value: (o) => o.type ?? "" }, keys("data")],
  "networking.k8s.io/ingresses": [
    { title: "Class", value: (o) => o.spec?.ingressClassName ?? o.metadata.annotations?.["kubernetes.io/ingress.class"] ?? "", width: "110px" },
    { title: "Load Balancers", value: (o) => ingressPoints(o).join(", ") },
    {
      title: "Rules",
      value: (o) => ingressRoutes(o).map((r) => `${r.url} ⇢ ${r.backend}`).join(", "),
      render: (o) => <IngressLinks ingress={o} />,
      width: "minmax(240px, 3fr)",
    },
  ],
  "/persistentvolumeclaims": [
    { title: "Status", value: (o) => o.status?.phase ?? "", render: (o) => <Status text={o.status?.phase ?? ""} /> },
    { title: "Volume", value: (o) => o.spec?.volumeName ?? "" },
    { title: "Capacity", value: (o) => o.status?.capacity?.storage ?? "" },
    { title: "Storage class", value: (o) => o.spec?.storageClassName ?? "" },
  ],
  "/persistentvolumes": [
    { title: "Capacity", value: (o) => o.spec?.capacity?.storage ?? "" },
    { title: "Status", value: (o) => o.status?.phase ?? "", render: (o) => <Status text={o.status?.phase ?? ""} /> },
    { title: "Claim", value: (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : "") },
    { title: "Storage class", value: (o) => o.spec?.storageClassName ?? "" },
  ],
  [CLAIMS]: [
    {
      title: "State",
      value: claimState,
      render: (o) => {
        const problem = claimProblem(o);
        return (
          <span className={`status ${problem ? "bad" : o.status?.allocation ? "ok" : "warn"}`} title={problem}>
            {claimState(o)}
          </span>
        );
      },
      width: "minmax(150px, 1fr)",
    },
    { title: "Device Classes", value: (o) => requestedClasses(o.spec).join(", "), width: "minmax(160px, 2fr)" },
  ],
  [CLAIM_TEMPLATES]: [{ title: "Device Classes", value: (o) => requestedClasses(o.spec?.spec).join(", "), width: "minmax(160px, 2fr)" }],
  [DEVICE_CLASSES]: [{ title: "Driver", value: classDrivers }],
  [SLICES]: [
    { title: "Driver", value: (o) => o.spec?.driver ?? "" },
    { title: "Pool", value: (o) => o.spec?.pool?.name ?? "" },
    { title: "Node", value: sliceNode },
    { title: "Devices", value: (o) => sliceDevices(o).length, width: "80px" },
  ],
  "storage.k8s.io/storageclasses": [
    { title: "Provisioner", value: (o) => o.provisioner ?? "" },
    { title: "Reclaim", value: (o) => o.reclaimPolicy ?? "" },
  ],
};

export function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <span className="meter" title={total ? `${pct.toFixed(0)}%` : undefined}>
      {total > 0 && (
        <span className="meter-bar">
          <span className={pct > 85 ? "bad" : pct > 65 ? "warn" : "ok"} style={{ width: `${pct}%` }} />
        </span>
      )}
      {label}
    </span>
  );
}

function metricColumns(id: string, metrics: MetricsMap): Column[] {
  if (id === "/pods") {
    const use = (o: KubeObject) => metrics.get(metricsKey(o.metadata.name, o.metadata.namespace));
    return [
      { title: "CPU", value: (o) => use(o)?.cpu ?? -1, render: (o) => (use(o) ? formatCpu(use(o)!.cpu) : "—"), width: "80px" },
      {
        title: "Memory",
        value: (o) => use(o)?.memory ?? -1,
        render: (o) => (use(o) ? formatBytes(use(o)!.memory) : "—"),
        width: "90px",
      },
    ];
  }
  if (id === "/nodes") {
    const use = (o: KubeObject) => metrics.get(metricsKey(o.metadata.name));
    const alloc = (o: KubeObject, r: string) => parseQuantity(o.status?.allocatable?.[r]);
    return [
      {
        title: "CPU usage",
        value: (o) => (use(o)?.cpu ?? 0) / (alloc(o, "cpu") || 1),
        render: (o) => (
          <Meter used={use(o)?.cpu ?? 0} total={alloc(o, "cpu")} label={`${formatCpu(use(o)?.cpu ?? 0)} / ${formatCpu(alloc(o, "cpu"))}`} />
        ),
        width: "minmax(150px, 1fr)",
      },
      {
        title: "Memory usage",
        value: (o) => (use(o)?.memory ?? 0) / (alloc(o, "memory") || 1),
        render: (o) => (
          <Meter
            used={use(o)?.memory ?? 0}
            total={alloc(o, "memory")}
            label={`${formatBytes(use(o)?.memory ?? 0)} / ${formatBytes(alloc(o, "memory"))}`}
          />
        ),
        width: "minmax(170px, 1fr)",
      },
    ];
  }
  return [];
}

const fluxColumns = (res: ResourceInfo): Column[] => [
  { title: "Status", value: fluxState, render: (o) => <Status text={fluxState(o)} />, width: "110px" },
  ...(res.group.startsWith("source.") || res.group.startsWith("notification.")
    ? []
    : [{ title: "Source", value: fluxSource } as Column]),
  ...(res.group.startsWith("source.") ? [{ title: "URL", value: (o: KubeObject) => o.spec?.url ?? "" } as Column] : []),
  { title: "Revision", value: fluxRevision },
  { title: "Message", value: fluxMessage, width: "minmax(220px, 3fr)" },
];

const argoAppColumns: Column[] = [
  { title: "Project", value: (o) => o.spec?.project ?? "", width: "110px" },
  { title: "Sync", value: argoSync, render: (o) => <Status text={argoSync(o)} />, width: "100px" },
  { title: "Health", value: argoHealth, render: (o) => <Status text={argoHealth(o)} />, width: "110px" },
  {
    title: "Last op",
    value: argoOperation,
    render: (o) => (argoOperation(o) ? <Status text={argoOperation(o)} /> : ""),
    width: "100px",
  },
  { title: "Source", value: argoSourceText, width: "minmax(200px, 2fr)" },
  { title: "Destination", value: argoDestination },
];

/** Columns of a resource list; `extra` (columns needing other resources, e.g. allocated devices) go before Age. */
export function columnsFor(res: ResourceInfo, allNamespaces: boolean, metrics?: MetricsMap | null, extra: Column[] = []): Column[] {
  const id = `${res.group}/${res.plural}`;
  const cols = [name];
  if (res.namespaced && allNamespaces) cols.push(namespace);
  if (id === "/pods") {
    // Column order: Name, Namespace, Containers, CPU, Memory, Restarts, Controlled By, Node, QoS, Age, Status.
    cols.push(podContainers);
    if (metrics) cols.push(...metricColumns(id, metrics));
    cols.push(...specific[id], ageCol, { title: "Status", value: podStatus, render: (o) => <Status text={podStatus(o)} />, width: "minmax(100px, 0.8fr)" });
    return cols;
  }
  cols.push(...(specific[id] ?? []));
  if (isFlux(res)) cols.push(...fluxColumns(res));
  if (id === "argoproj.io/applications") cols.push(...argoAppColumns);
  if (metrics) cols.push(...metricColumns(id, metrics));
  cols.push(...extra);
  if (res.plural !== "events") cols.push(ageCol);
  return cols;
}
