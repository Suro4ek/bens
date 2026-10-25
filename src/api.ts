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
  /** Catalog id of the cluster it forwards into. */
  cluster: string;
  kind: "pod" | "service";
  namespace: string;
  name: string;
  remotePort: number;
  localPort: number;
  protocol: "http" | "https";
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
 * Bumped per cluster on every connect and disconnect. Watches, metrics and
 * charts key their subscriptions on it: reconnecting a cluster drops its
 * backend streams, so everything that was listening has to subscribe again.
 */
const epochs = new Map<string, number>();
const epochListeners = new Set<() => void>();
export const connectionEpoch = {
  get: (cluster: string) => epochs.get(cluster) ?? 0,
  subscribe(listener: () => void) {
    epochListeners.add(listener);
    return () => void epochListeners.delete(listener);
  },
  bump(cluster: string) {
    epochs.set(cluster, (epochs.get(cluster) ?? 0) + 1);
    epochListeners.forEach((l) => l());
  },
};

/** Errors of fire-and-forget calls (opening links), for the app to show. */
const errorListeners = new Set<(message: string) => void>();
export const onApiError = (listener: (message: string) => void) => {
  errorListeners.add(listener);
  return () => void errorListeners.delete(listener);
};
const reportError = (message: string) => errorListeners.forEach((l) => l(message));

let seq = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/** Calls that are not about one cluster: the catalog, preferences, terminals by session id, links. */
export const api = {
  listContexts: () => invoke<Contexts>("list_contexts"),
  addKubeconfigText: (yaml: string) => invoke<number>("add_kubeconfig_text", { yaml }),
  addKubeconfigPath: (path: string) => invoke<void>("add_kubeconfig_path", { path }),
  removeKubeconfigSource: (path: string) => invoke<void>("remove_kubeconfig_source", { path }),
  saveTextFile: (path: string, contents: string) => invoke<void>("save_text_file", { path, contents }),
  /** A file's contents, base64-encoded (for ConfigMap and Secret values). */
  readFileBase64: (path: string) => invoke<string>("read_file_base64", { path }),
  loadIconImage: (path: string) => invoke<string>("load_icon_image", { path }),
  readKubeconfig: (file: string) => invoke<string>("read_kubeconfig", { file }),
  writeKubeconfig: (file: string, yaml: string) => invoke<void>("write_kubeconfig", { file, yaml }),
  deleteContext: (file: string, context: string) => invoke<void>("delete_context", { file, context }),

  /** Connects (or reconnects) a cluster; other connected clusters are left alone. */
  connect: (ctx: ContextInfo) =>
    invoke<Connection>("connect", { file: ctx.file, context: ctx.name }).then((c) => {
      connectionEpoch.bump(ctx.id);
      return c;
    }),
  disconnect: (cluster: string) => invoke<void>("disconnect", { cluster }).finally(() => connectionEpoch.bump(cluster)),

  // Sessions are addressed by id, whichever cluster they belong to.
  execInput: (sessionId: string, data: string) => invoke<void>("exec_input", { sessionId, data }),
  execResize: (sessionId: string, cols: number, rows: number) => invoke<void>("exec_resize", { sessionId, cols, rows }),
  execStop: (sessionId: string) => invoke<void>("exec_stop", { sessionId }),
  stopStream: (id: string) => invoke<void>("stop_stream", { id }),
  portForwardList: () => invoke<ForwardInfo[]>("port_forward_list"),
  portForwardStop: (id: string) => invoke<void>("port_forward_stop", { id }),

  helmRepoList: () => invoke<HelmRepo[]>("helm_repo_list"),
  helmRepoAdd: (name: string, url: string) => invoke<string>("helm_repo_add", { name, url }),
  helmRepoUpdate: () => invoke<string>("helm_repo_update"),
  helmSearch: (query: string, versions = false) => invoke<ChartHit[]>("helm_search", { query, versions }),
  helmShowValues: (chart: string, version: string) => invoke<string>("helm_show_values", { chart, version }),

  /** Opens a link in the default browser; a failure is reported (shown as a toast), never swallowed. */
  openUrl: (url: string) => openUrl(url).catch((e) => reportError(`Couldn't open ${url}: ${e}`)),
  reveal: (path: string) => revealItemInDir(path),
};

/** Calls against one connected cluster, by its catalog id. */
function makeClusterApi(cluster: string) {
  const call = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { cluster, ...args });
  /** Starts a backend stream that reports through a channel; returns its stop function. */
  const stream = <E>(cmd: string, prefix: string, args: Record<string, unknown>, onEvent: (e: E) => void, onError: (msg: string) => void) => {
    const id = newId(prefix);
    const ch = new Channel<E>();
    ch.onmessage = onEvent;
    const started = call(cmd, { ...args, [prefix === "watch" ? "watchId" : "streamId"]: id, onEvent: ch }).catch((e) => onError(String(e)));
    return () => {
      ch.onmessage = () => {};
      started.finally(() => api.stopStream(id));
    };
  };
  const session = (cmd: string, sessionId: string, args: Record<string, unknown>, onEvent: (e: ExecEvent) => void) => {
    const ch = new Channel<ExecEvent>();
    ch.onmessage = onEvent;
    return call<void>(cmd, { sessionId, ...args, onEvent: ch });
  };

  return {
    cluster,
    watch: (key: string, namespace: string | null, onEvent: (e: WatchEvent) => void, opts: WatchOptions = {}) =>
      stream<WatchEvent>("watch_resources", "watch", { key, namespace, ...opts }, onEvent, (message) => onEvent({ type: "error", message })),
    logs: (
      opts: { namespace: string; pod: string; container?: string; tailLines?: number; previous: boolean; timestamps: boolean },
      onEvent: (e: LogEvent) => void,
    ) => stream<LogEvent>("stream_logs", "logs", opts, onEvent, (message) => onEvent({ type: "error", message })),

    getYaml: (key: string, namespace: string | undefined, name: string) => call<string>("get_yaml", { key, namespace, name }),
    /** One object; null when it doesn't exist. */
    getObject: (key: string, namespace: string | undefined, name: string) =>
      call<KubeObject | null>("get_object", { key, namespace, name }),
    applyYaml: (key: string, namespace: string | undefined, name: string, yaml: string) =>
      call<string>("apply_yaml", { key, namespace, name, yaml }),
    delete: (key: string, namespace: string | undefined, name: string) => call<void>("delete_resource", { key, namespace, name }),
    scale: (key: string, namespace: string | undefined, name: string, replicas: number) =>
      call<void>("scale_resource", { key, namespace, name, replicas }),
    restart: (key: string, namespace: string | undefined, name: string) => call<void>("restart_rollout", { key, namespace, name }),
    patch: (key: string, namespace: string | undefined, name: string, patch: unknown) =>
      call<void>("patch_resource", { key, namespace, name, patch }),
    applyManifest: (yaml: string, namespace: string | null) => call<string[]>("apply_manifest", { yaml, namespace }),
    /** Creates an object; fails if it already exists. */
    create: (key: string, namespace: string | undefined, object: unknown) =>
      call<KubeObject>("create_resource", { key, namespace, object }),
    /** Creates an object or replaces the existing one; resolves to true when it was created. */
    put: (key: string, namespace: string | undefined, object: unknown) => call<boolean>("put_resource", { key, namespace, object }),
    /** A kubeconfig for a service account: its token Secret, or a token requested for `hours`. */
    serviceAccountKubeconfig: (namespace: string, name: string, hours?: number) =>
      call<{ kubeconfig: string; tokenSource: "secret" | "token-request"; expires?: string }>("service_account_kubeconfig", {
        namespace,
        name,
        hours,
      }),

    execStart: (
      sessionId: string,
      opts: { namespace: string; pod: string; container?: string; cols: number; rows: number },
      onEvent: (e: ExecEvent) => void,
    ) => session("exec_start", sessionId, opts, onEvent),
    localTerminalStart: (sessionId: string, opts: { cols: number; rows: number }, onEvent: (e: ExecEvent) => void) =>
      session("local_terminal_start", sessionId, opts, onEvent),
    nodeShellStart: (sessionId: string, opts: { node: string; cols: number; rows: number }, onEvent: (e: ExecEvent) => void) =>
      session("node_shell_start", sessionId, opts, onEvent),

    getMetrics: (scope: "pods" | "nodes", namespace?: string | null) => call<KubeObject[]>("get_metrics", { scope, namespace }),
    portForwardStart: (
      kind: "pod" | "service",
      namespace: string,
      name: string,
      remotePort: number,
      localPort?: number,
      protocol: "http" | "https" = "http",
    ) => call<ForwardInfo>("port_forward_start", { kind, namespace, name, remotePort, localPort, protocol }),

    nodeCordon: (name: string, unschedulable: boolean) => call<void>("node_cordon", { name, unschedulable }),
    nodeDrain: (name: string) => call<DrainResult>("node_drain", { name }),

    helmList: (namespace: string | null) => call<HelmRelease[]>("helm_list", { namespace }),
    helmGet: (namespace: string, name: string) => call<HelmDetails>("helm_get", { namespace, name }),
    helmRollback: (namespace: string, name: string, revision: number) => call<string>("helm_rollback", { namespace, name, revision }),
    helmUninstall: (namespace: string, name: string) => call<string>("helm_uninstall", { namespace, name }),
    helmInstall: (name: string, namespace: string, chart: string, version: string, values: string) =>
      call<string>("helm_install", { name, namespace, chart, version, values }),

    prometheusDetect: () => call<PromService | null>("prometheus_detect"),
    prometheusRange: (query: string, start: number, end: number, step: number) =>
      call<PromSeries[]>("prometheus_query_range", { query, start, end, step }),
    costFindService: (selectors: string[], preferredPort: number) => call<string | null>("cost_find_service", { selectors, preferredPort }),
    serviceProxyGet: (address: string, path: string, query: Record<string, string>) =>
      call<unknown>("service_proxy_get", { address, path, query: Object.entries(query) }),
  };
}

export type ClusterApi = ReturnType<typeof makeClusterApi>;

const clusterApis = new Map<string, ClusterApi>();
/** The API of one cluster; the same object every time, so it can be a hook dependency. */
export function clusterApi(cluster: string): ClusterApi {
  let a = clusterApis.get(cluster);
  if (!a) clusterApis.set(cluster, (a = makeClusterApi(cluster)));
  return a;
}
