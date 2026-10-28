import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ContextInfo } from "./api";
import { hashColor } from "./util";

export interface AppPrefs {
  theme: "dark" | "light" | "system";
  reconnectLast: boolean;
  shell: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalCopyOnSelect: boolean;
  editorFontSize: number;
  editorTabSize: number;
  editorLineWrap: boolean;
  logTailLines: number;
  helmPath: string;
  httpProxy: string;
  allowUntrustedCa: boolean;
}

export interface ClusterPrefs {
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  iconImage?: string | null;
  hideFromHotbar?: boolean;
  httpProxy?: string | null;
  /** ssh arguments of a tunnel to the API server: `-L 6443:10.2.9.152:6443 me@bastion`. */
  sshTunnel?: string | null;
  terminalNamespace?: string | null;
  terminalCwd?: string | null;
  accessibleNamespaces?: string[];
  prometheusMode?: "auto" | "manual" | "off" | null;
  prometheusService?: string | null;
  prometheusPrefix?: string | null;
  hiddenMetrics?: string[];
  nodeShellImage?: string | null;
  nodeShellPullSecret?: string | null;
  costSource?: "auto" | "kubecost" | "opencost" | "estimated" | "off" | null;
  costAddress?: string | null;
  costCpuRate?: number | null;
  costRamRate?: number | null;
  costSpotDiscount?: number | null;
  costCurrency?: string | null;
}

export interface Prefs {
  app: AppPrefs;
  clusters: Record<string, ClusterPrefs>;
}

export const DEFAULT_APP: AppPrefs = {
  theme: "dark",
  reconnectLast: true,
  shell: "",
  terminalFontSize: 13,
  terminalFontFamily: "",
  terminalCopyOnSelect: false,
  editorFontSize: 12,
  editorTabSize: 2,
  editorLineWrap: false,
  logTailLines: 1000,
  helmPath: "",
  httpProxy: "",
  allowUntrustedCa: false,
};

export const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

let current: Prefs = { app: DEFAULT_APP, clusters: {} };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const loadPrefs = () =>
  invoke<Prefs>("get_prefs").then((p) => {
    current = { ...current, app: { ...DEFAULT_APP, ...p.app }, clusters: p.clusters ?? {} };
    applyTheme(current.app.theme);
    emit();
  });

export async function saveAppPrefs(patch: Partial<AppPrefs>) {
  const app = { ...current.app, ...patch };
  await invoke("save_app_prefs", { prefs: app });
  current = { ...current, app };
  applyTheme(app.theme);
  emit();
}

export async function saveClusterPrefs(id: string, patch: Partial<ClusterPrefs>) {
  const prefs = { ...current.clusters[id], ...patch };
  await invoke("save_cluster_prefs", { id, prefs });
  current = { ...current, clusters: { ...current.clusters, [id]: prefs } };
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const usePrefs = () => useSyncExternalStore(subscribe, () => current);
export const useAppPrefs = () => usePrefs().app;
export const getAppPrefs = () => current.app;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(theme: AppPrefs["theme"]) {
  const dark = theme === "dark" || (theme === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
darkQuery.addEventListener("change", () => {
  applyTheme(current.app.theme);
  // New snapshot so terminals and editors re-read the theme.
  current = { ...current, app: { ...current.app } };
  emit();
});
export const isDark = () => document.documentElement.dataset.theme !== "light";

// --- cluster appearance ----------------------------------------------------

export const initials = (name: string) =>
  name
    .split(/[-_.@/\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export const clusterName = (c: ContextInfo, p?: ClusterPrefs) => p?.name?.trim() || c.name;
export const clusterColor = (c: ContextInfo, p?: ClusterPrefs) => p?.color || hashColor(c.id);
export const clusterIcon = (c: ContextInfo, p?: ClusterPrefs) => p?.icon?.trim() || initials(clusterName(c, p));
