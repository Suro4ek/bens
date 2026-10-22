import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export interface ContextInfo {
  /** `<file>#<context>`, unique across kubeconfig files. */
  id: string;
  name: string;
  file: string;
  pasted: boolean;
  cluster: string;
  user: string;
  namespace?: string;
  server?: string;
}

export interface SourceInfo {
  path: string;
  kind: "sync" | "env" | "pasted";
  exists: boolean;
  contexts: number;
  errors: string[];
}

export interface Contexts {
  current?: string;
  sources: SourceInfo[];
  contexts: ContextInfo[];
}

export interface ResourceInfo {
  key: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

export interface Connection {
  context: string;
  serverVersion: string;
  defaultNamespace: string;
  metrics: boolean;
  resources: ResourceInfo[];
}

/** A Kubernetes object as returned by the dynamic API (managedFields stripped). */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { apiVersion: string; kind: string; name: string; uid: string; controller?: boolean }[];
    resourceVersion?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [field: string]: any;
}

export type WatchEvent =
  | { type: "reset"; items: KubeObject[] }
  | { type: "apply"; object: KubeObject }
  | { type: "delete"; object: KubeObject }
  | { type: "error"; message: string };

export type LogEvent =
  | { type: "lines"; lines: string[] }
  | { type: "end" }
  | { type: "error"; message: string };

export interface ForwardInfo {
  id: string;
  kind: "pod" | "service";
  namespace: string;
  name: string;
  remotePort: number;
  localPort: number;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chartVersion: string;
  appVersion: string;
  updated: string;
  description: string;
}

export interface HelmDetails {
  summary: HelmRelease;
  history: HelmRelease[];
  values: string;
  defaultValues: string;
  manifest: string;
  notes: string;
}

export interface DrainResult {
  evicted: string[];
  skipped: string[];
  failed: string[];
}

export interface PromSeries {
  metric: Record<string, string>;
  values: [number, number][];
}

export interface PromService {
  namespace: string;
  service: string;
  port: number;
}

export interface HelmRepo {
  name: string;
  url: string;
}

export interface ChartHit {
  name: string;
  version: string;
  app_version: string;
  description: string;
}

export interface WatchOptions {
  labelSelector?: string;
  fieldSelector?: string;
}

export type ExecEvent = { type: "data"; data: string } | { type: "exit"; message?: string };

/**
 * Bumped on every connect and disconnect. Watches, metrics and charts key their
 * subscriptions on it: the same resource key (say `/v1/namespaces`) means a
 * different cluster after a switch, and the backend drops the old streams.
 */
let epoch = 0;
const epochListeners = new Set<() => void>();
export const connectionEpoch = {
  get: () => epoch,
  subscribe(listener: () => void) {
    epochListeners.add(listener);
    return () => void epochListeners.delete(listener);
  },
  bump() {
    epoch++;
    epochListeners.forEach((l) => l());
  },
};

let seq = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

export const api = {
  listContexts: () => invoke<Contexts>("list_contexts"),
  addKubeconfigText: (yaml: string) => invoke<number>("add_kubeconfig_text", { yaml }),
  addKubeconfigPath: (path: string) => invoke<void>("add_kubeconfig_path", { path }),
  removeKubeconfigSource: (path: string) => invoke<void>("remove_kubeconfig_source", { path }),
  saveTextFile: (path: string, contents: string) => invoke<void>("save_text_file", { path, contents }),
  loadIconImage: (path: string) => invoke<string>("load_icon_image", { path }),
  readKubeconfig: (file: string) => invoke<string>("read_kubeconfig", { file }),
  writeKubeconfig: (file: string, yaml: string) => invoke<void>("write_kubeconfig", { file, yaml }),
  deleteContext: (file: string, context: string) => invoke<void>("delete_context", { file, context }),
  connect: (ctx: ContextInfo) =>
    invoke<Connection>("connect", { file: ctx.file, context: ctx.name }).then((c) => {
      connectionEpoch.bump();
      return c;
    }),
  disconnect: () => invoke<void>("disconnect").finally(connectionEpoch.bump),

  watch(key: string, namespace: string | null, onEvent: (e: WatchEvent) => void, opts: WatchOptions = {}) {
    const watchId = newId("watch");
    const ch = new Channel<WatchEvent>();
    ch.onmessage = onEvent;
    const started = invoke("watch_resources", { watchId, key, namespace, ...opts, onEvent: ch }).catch((e) =>
      onEvent({ type: "error", message: String(e) }),
    );
    return () => {
      ch.onmessage = () => {};
      started.finally(() => invoke("stop_stream", { id: watchId }));
    };
  },

  getYaml: (key: string, namespace: string | undefined, name: string) =>
    invoke<string>("get_yaml", { key, namespace, name }),
  applyYaml: (key: string, namespace: string | undefined, name: string, yaml: string) =>
    invoke<string>("apply_yaml", { key, namespace, name, yaml }),
  delete: (key: string, namespace: string | undefined, name: string) =>
    invoke<void>("delete_resource", { key, namespace, name }),
  scale: (key: string, namespace: string | undefined, name: string, replicas: number) =>
    invoke<void>("scale_resource", { key, namespace, name, replicas }),
  restart: (key: string, namespace: string | undefined, name: string) =>
    invoke<void>("restart_rollout", { key, namespace, name }),

  logs(
    opts: {
      namespace: string;
      pod: string;
      container?: string;
      tailLines?: number;
      previous: boolean;
      timestamps: boolean;
    },
    onEvent: (e: LogEvent) => void,
  ) {
    const streamId = newId("logs");
    const ch = new Channel<LogEvent>();
    ch.onmessage = onEvent;
    const started = invoke("stream_logs", { streamId, ...opts, onEvent: ch }).catch((e) =>
      onEvent({ type: "error", message: String(e) }),
    );
    return () => {
      ch.onmessage = () => {};
      started.finally(() => invoke("stop_stream", { id: streamId }));
    };
  },

  execStart: (
    sessionId: string,
    opts: { namespace: string; pod: string; container?: string; cols: number; rows: number },
    onEvent: (e: ExecEvent) => void,
  ) => {
    const ch = new Channel<ExecEvent>();
    ch.onmessage = onEvent;
    return invoke<void>("exec_start", { sessionId, ...opts, onEvent: ch });
  },
  localTerminalStart: (sessionId: string, opts: { cols: number; rows: number }, onEvent: (e: ExecEvent) => void) => {
    const ch = new Channel<ExecEvent>();
    ch.onmessage = onEvent;
    return invoke<void>("local_terminal_start", { sessionId, ...opts, onEvent: ch });
  },
  nodeShellStart: (
    sessionId: string,
    opts: { node: string; cols: number; rows: number },
    onEvent: (e: ExecEvent) => void,
  ) => {
    const ch = new Channel<ExecEvent>();
    ch.onmessage = onEvent;
    return invoke<void>("node_shell_start", { sessionId, ...opts, onEvent: ch });
  },
  execInput: (sessionId: string, data: string) => invoke<void>("exec_input", { sessionId, data }),
  execResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("exec_resize", { sessionId, cols, rows }),
  execStop: (sessionId: string) => invoke<void>("exec_stop", { sessionId }),

  getMetrics: (scope: "pods" | "nodes", namespace?: string | null) =>
    invoke<KubeObject[]>("get_metrics", { scope, namespace }),

  portForwardStart: (kind: "pod" | "service", namespace: string, name: string, remotePort: number, localPort?: number) =>
    invoke<ForwardInfo>("port_forward_start", { kind, namespace, name, remotePort, localPort }),
  portForwardList: () => invoke<ForwardInfo[]>("port_forward_list"),
  portForwardStop: (id: string) => invoke<void>("port_forward_stop", { id }),

  applyManifest: (yaml: string, namespace: string | null) => invoke<string[]>("apply_manifest", { yaml, namespace }),

  nodeCordon: (name: string, unschedulable: boolean) => invoke<void>("node_cordon", { name, unschedulable }),
  nodeDrain: (name: string) => invoke<DrainResult>("node_drain", { name }),

  helmList: (namespace: string | null) => invoke<HelmRelease[]>("helm_list", { namespace }),
  helmGet: (namespace: string, name: string) => invoke<HelmDetails>("helm_get", { namespace, name }),
  helmRollback: (namespace: string, name: string, revision: number) =>
    invoke<string>("helm_rollback", { namespace, name, revision }),
  helmUninstall: (namespace: string, name: string) => invoke<string>("helm_uninstall", { namespace, name }),

  patch: (key: string, namespace: string | undefined, name: string, patch: unknown) =>
    invoke<void>("patch_resource", { key, namespace, name, patch }),

  prometheusDetect: () => invoke<PromService | null>("prometheus_detect"),
  prometheusRange: (query: string, start: number, end: number, step: number) =>
    invoke<PromSeries[]>("prometheus_query_range", { query, start, end, step }),

  costFindService: (selectors: string[], preferredPort: number) =>
    invoke<string | null>("cost_find_service", { selectors, preferredPort }),
  serviceProxyGet: (address: string, path: string, query: Record<string, string>) =>
    invoke<unknown>("service_proxy_get", { address, path, query: Object.entries(query) }),

  helmRepoList: () => invoke<HelmRepo[]>("helm_repo_list"),
  helmRepoAdd: (name: string, url: string) => invoke<string>("helm_repo_add", { name, url }),
  helmRepoUpdate: () => invoke<string>("helm_repo_update"),
  helmSearch: (query: string, versions = false) => invoke<ChartHit[]>("helm_search", { query, versions }),
  helmShowValues: (chart: string, version: string) => invoke<string>("helm_show_values", { chart, version }),
  helmInstall: (name: string, namespace: string, chart: string, version: string, values: string) =>
    invoke<string>("helm_install", { name, namespace, chart, version, values }),

  openUrl: (url: string) => openUrl(url),
  reveal: (path: string) => revealItemInDir(path),
};
