import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Connection } from "../api";
import { ClusterContext } from "../clusterContext";
import type { Column } from "../columns";
import { allocatedInSlice, allocationMap, CLAIMS, SLICES } from "../dra";
import { ARGO, COST, FLUX, HELM, navId, OVERVIEW, PORT_FORWARDS, SPECIAL_VIEWS, WORKLOADS_OVERVIEW } from "../nav";
import type { ClusterPrefs } from "../prefs";
import { useMetrics } from "../useMetrics";
import { useWatch } from "../useWatch";
import { CostDashboard } from "./CostDashboard";
import { CreateConfigMapDialog, CreateSecretDialog } from "./CreateDialogs";
import { ClusterChoice, CopyDialog } from "./CopyDialog";
import { KubeconfigDialog } from "./KubeconfigDialog";
import { COPYABLE } from "../copy";
import type { KubeObject } from "../api";
import { templateFor } from "../templates";
import { DetailsPanel, DockActions } from "./DetailsPanel";
import { ArgoDashboard, FluxDashboard } from "./GitOpsDashboards";
import { HelmReleases } from "./HelmReleases";
import { ALL_NAMESPACES as ALL, NamespaceContext } from "./NamespaceSelect";
import { Overview } from "./Overview";
import { PortForwards } from "./PortForwards";
import { ResourceTable } from "./ResourceTable";
import { WorkloadsOverview } from "./WorkloadsOverview";

export type Navigate = (view: string, uid?: string, ref?: { namespace?: string; name: string }) => void;

interface Props {
  cluster: string;
  conn: Connection;
  prefs: ClusterPrefs;
  view: string;
  /** Selected object: a uid, or `ref:<namespace>/<name>` when navigating by name. */
  selected?: string;
  namespace: string;
  onNamespace: (ns: string) => void;
  onSelect: (sel?: string) => void;
  onNavigate: Navigate;
  /** Reports the cluster's namespaces, for the command palette. */
  onNamespaceNames: (names: string[]) => void;
  onOpenSettings: (section?: string) => void;
  actions: DockActions;
  notify: (msg: string, tone?: "ok" | "bad") => void;
  /** Connected clusters, to copy Secrets and ConfigMaps to. */
  clusters: ClusterChoice[];
  /** Where the details panel goes: beside the content and the dock, full height. */
  detailsSlot: HTMLElement | null;
}

/** The main area for one cluster's tab: everything in it talks to that cluster. */
export function ClusterView(props: Props) {
  return (
    <ClusterContext.Provider value={props.cluster}>
      <ClusterContent {...props} />
    </ClusterContext.Provider>
  );
}

function ClusterContent({
  cluster,
  conn,
  prefs,
  view,
  selected,
  namespace,
  onNamespace,
  onSelect,
  onNavigate,
  onNamespaceNames,
  onOpenSettings,
  actions,
  notify,
  detailsSlot,
  clusters,
}: Props) {
  const byNav = useMemo(() => new Map(conn.resources.map((r) => [navId(r), r])), [conn]);
  const resource = view in SPECIAL_VIEWS ? undefined : byNav.get(view);
  const nsParam = namespace === ALL ? null : namespace;

  const namespaces = useWatch(byNav.get("/namespaces")?.key, null);
  // Namespaces from the cluster plus the ones configured as accessible (for users who can't list them).
  const namespaceNames = useMemo(
    () => [...new Set([...namespaces.items.map((n) => n.metadata.name), ...(prefs.accessibleNamespaces ?? [])])].sort(),
    [namespaces.items, prefs.accessibleNamespaces],
  );
  useEffect(() => onNamespaceNames(namespaceNames), [namespaceNames, onNamespaceNames]);

  const watch = useWatch(resource?.key, resource?.namespaced ? nsParam : null);
  const selectedObj = watch.items.find(
    (o) => o.metadata.uid === selected || `ref:${o.metadata.namespace ?? ""}/${o.metadata.name}` === selected,
  );

  // Resource Slices show how many of their devices are allocated, which only the claims know.
  const claimsKey = byNav.get(CLAIMS)?.key;
  const claims = useWatch(view === SLICES ? claimsKey : undefined, null);
  const sliceColumns = useMemo((): Column[] | undefined => {
    if (view !== SLICES || !claimsKey || claims.error) return undefined;
    const map = allocationMap(claims.items);
    return [{ title: "Allocated", value: (o) => allocatedInSlice(o, map), width: "90px" }];
  }, [view, claimsKey, claims.items, claims.error]);

  // "+" on Secrets and ConfigMaps opens a form (Lens' "Create Secret"); on other lists, the editor with a template.
  const [creating, setCreating] = useState<"/secrets" | "/configmaps" | null>(null);
  const onCreate =
    resource && (view === "/secrets" || view === "/configmaps")
      ? () => setCreating(view)
      : resource && view !== "/events"
        ? () => actions.openCreate(templateFor(resource, nsParam))
        : undefined;
  const dialogProps = resource && {
    resource,
    namespace: nsParam,
    namespaces: namespaceNames,
    onClose: () => setCreating(null),
    onCreated: (namespace: string, name: string) => onNavigate(view, undefined, { namespace, name }),
    notify,
  };

  const [copying, setCopying] = useState<KubeObject[] | null>(null);
  const [kubeconfigFor, setKubeconfigFor] = useState<KubeObject | null>(null);
  const openKubeconfig = view === "/serviceaccounts" ? setKubeconfigFor : undefined;
  const onCopy = resource && COPYABLE.has(view) ? setCopying : undefined;

  const podMetrics = useMetrics("pods", nsParam, conn.metrics && view === "/pods");
  const nodeMetrics = useMetrics("nodes", null, conn.metrics && (view === "/nodes" || view === OVERVIEW));

  return (
    <NamespaceContext.Provider value={{ value: namespace, names: namespaceNames, set: onNamespace }}>
      {view === OVERVIEW && <Overview conn={conn} namespace={nsParam} nodeMetrics={nodeMetrics} onOpen={onNavigate} />}
      {view === WORKLOADS_OVERVIEW && <WorkloadsOverview conn={conn} namespace={nsParam} onNavigate={onNavigate} />}
      {view === PORT_FORWARDS && <PortForwards notify={notify} />}
      {view === HELM && <HelmReleases namespace={nsParam} notify={notify} />}
      {view === FLUX && <FluxDashboard conn={conn} namespace={nsParam} onNavigate={onNavigate} notify={notify} />}
      {view === ARGO && <ArgoDashboard conn={conn} namespace={nsParam} onNavigate={onNavigate} notify={notify} />}
      {view === COST && (
        <CostDashboard conn={conn} clusterId={cluster} prefs={prefs} onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      )}
      {!resource && !(view in SPECIAL_VIEWS) && <div className="empty-view muted">This resource is not available in the cluster.</div>}
      {resource && (
        <ResourceTable
          key={resource.key}
          resource={resource}
          watch={watch}
          allNamespaces={!nsParam}
          metrics={view === "/pods" ? podMetrics : view === "/nodes" ? nodeMetrics : null}
          extraColumns={sliceColumns}
          selectedUid={selected}
          onSelect={(o) => onSelect(o.metadata.uid)}
          notify={notify}
          actions={actions}
          onCreate={onCreate}
          onCopy={onCopy}
          openKubeconfig={openKubeconfig}
        />
      )}
      {kubeconfigFor && <KubeconfigDialog account={kubeconfigFor} onClose={() => setKubeconfigFor(null)} notify={notify} />}
      {copying && resource && (
        <CopyDialog
          resource={resource}
          objects={copying}
          sourceCluster={cluster}
          clusters={clusters}
          onClose={() => setCopying(null)}
          notify={notify}
        />
      )}
      {creating === "/secrets" && dialogProps && <CreateSecretDialog {...dialogProps} />}
      {creating === "/configmaps" && dialogProps && <CreateConfigMapDialog {...dialogProps} />}
      {resource &&
        selectedObj &&
        detailsSlot &&
        createPortal(
          <DetailsPanel
            key={selected}
            resource={resource}
            resources={conn.resources}
            obj={selectedObj}
            onClose={() => onSelect(undefined)}
            onNavigate={onNavigate}
            notify={notify}
            onCopy={onCopy && (() => onCopy([selectedObj]))}
            onKubeconfig={openKubeconfig && (() => openKubeconfig(selectedObj))}
            {...actions}
          />,
          detailsSlot,
        )}
    </NamespaceContext.Provider>
  );
}
