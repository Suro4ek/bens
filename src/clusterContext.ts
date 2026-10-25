import { createContext, useContext, useSyncExternalStore } from "react";
import { clusterApi, ClusterApi, connectionEpoch } from "./api";
import { ClusterPrefs, usePrefs } from "./prefs";

/** Catalog id of the cluster a part of the UI belongs to (a tab, a dock tab, a details panel). */
export const ClusterContext = createContext<string | null>(null);

export function useClusterId(): string {
  const id = useContext(ClusterContext);
  if (!id) throw new Error("useClusterId outside a ClusterContext");
  return id;
}

/** The API of the cluster this component belongs to. */
export const useApi = (): ClusterApi => clusterApi(useClusterId());

/** Settings of the cluster this component belongs to. */
export const useClusterPrefs = (): ClusterPrefs => usePrefs().clusters[useClusterId()] ?? {};

/** The cluster's name as the app shows it: the one from its settings, or the kubeconfig context's (`file#context`). */
export function useClusterName(): string {
  const id = useClusterId();
  return useClusterPrefs().name?.trim() || id.slice(id.lastIndexOf("#") + 1);
}

/** Changes whenever this component's cluster connects or reconnects. */
export function useConnectionEpoch(cluster = useContext(ClusterContext)): number {
  return useSyncExternalStore(connectionEpoch.subscribe, () => (cluster ? connectionEpoch.get(cluster) : 0));
}
