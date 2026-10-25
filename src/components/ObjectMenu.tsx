import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownToLine,
  ChevronRight,
  ClipboardCopy,
  Copy,
  CopyPlus,
  ExternalLink,
  KeyRound,
  FileText,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Scaling,
  SquareTerminal,
  Trash2,
  Zap,
} from "lucide-react";
import { api, ClusterApi, KubeObject, ResourceInfo } from "../api";
import { ingressRoutes } from "../ingress";
import { useApi } from "../clusterContext";
import { Brick } from "../columns";
import { copyText, eventText } from "../clipboard";
import { argoRefresh, argoSyncApp, fluxReconcile, fluxSuspend, isFlux } from "../gitops";
import { ask, askDelete } from "./Confirm";
import type { DockActions } from "./DetailsPanel";
import { ALL } from "./LogsView";

type Notify = (msg: string, tone?: "ok" | "bad") => void;

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  /** Shown before the label, e.g. a container's status brick. */
  hint?: ReactNode;
  /** Shown in bold (e.g. "All containers" above the containers). */
  strong?: boolean;
  danger?: boolean;
  run?: () => unknown;
  children?: MenuItem[];
}

/** Workloads whose pods' logs can be shown together. */
export const LOG_WORKLOADS = new Set([
  "apps/deployments",
  "apps/statefulsets",
  "apps/daemonsets",
  "apps/replicasets",
  "batch/jobs",
  "/replicationcontrollers",
]);
const SCALABLE = new Set(["apps/deployments", "apps/statefulsets", "apps/replicasets"]);
const RESTARTABLE = new Set(["apps/deployments", "apps/statefulsets", "apps/daemonsets"]);

interface MenuContext {
  /** API of the cluster the object is in. */
  capi: ClusterApi;
  /** That cluster's name, for confirmations. */
  clusterName: string;
  resource: ResourceInfo;
  actions: DockActions;
  notify: Notify;
  /** "Copy to…" another cluster or namespace (Secrets, ConfigMaps); `count` > 1 when it copies the checked rows. */
  copyTo?: { count: number; run: () => void };
  /** Text selected with the mouse in the row; offered first as "Copy". */
  selection?: string;
  /** Kubeconfig for a service account (Lens' "Kubeconfig" item). */
  openKubeconfig?: (obj: KubeObject) => void;
  /** Asks for a replica count (the app's own dialog: WebKit has no window.prompt). */
  askScale: (obj: KubeObject) => void;
}

/** Runs an action and reports how it went, like the details panel does. */
const runner = (notify: Notify) => (done: string, f: () => Promise<unknown>) => () =>
  f().then(
    () => notify(done),
    (e) => notify(String(e), "bad"),
  );

/** Same Job `kubectl create job --from=cronjob/<name>` makes. */
function triggerCronJob(capi: ClusterApi, obj: KubeObject) {
  const name = `${obj.metadata.name}-manual-${Math.floor(Date.now() / 1000).toString(36)}`.slice(0, 63);
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: obj.metadata.namespace,
      annotations: { "cronjob.kubernetes.io/instantiate": "manual" },
      labels: obj.spec?.jobTemplate?.metadata?.labels,
      ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: obj.metadata.name, uid: obj.metadata.uid, controller: true }],
    },
    spec: obj.spec?.jobTemplate?.spec,
  };
  return capi.applyManifest(JSON.stringify(job), obj.metadata.namespace ?? null).then(() => name);
}

/** A pod's containers with their status bricks, optionally led by an "all containers" entry. */
export function containerItems(pod: KubeObject, open: (c: string) => void, all?: string): MenuItem[] {
  const names = [...((pod.spec?.initContainers ?? []) as any[]), ...((pod.spec?.containers ?? []) as any[])].map((c) => c.name as string);
  return [
    ...(all ? [{ label: all, strong: true, run: () => open(ALL) }] : []),
    ...names.map((c) => ({ label: c, hint: <Brick pod={pod} name={c} />, run: () => open(c) })),
  ];
}

/** Icon button that opens a container list on hover (Shell / Logs in the details toolbar); a click runs the default. */
export function HoverMenu({
  icon: Icon,
  title,
  items,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  items: MenuItem[];
  onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const show = () => (clearTimeout(timer.current), setOpen(true));
  const hide = () => (timer.current = window.setTimeout(() => setOpen(false), 150));
  return (
    <div className="hover-menu" onMouseEnter={show} onMouseLeave={hide}>
      <button className="icon" title={open ? undefined : title} onClick={onClick}>
        <Icon size={16} />
      </button>
      {open && (
        <div className="ctx-menu hover-menu-list">
          <div className="hover-menu-title">{title}</div>
          {items.map((c) => (
            <div
              key={c.label}
              className="ctx-item"
              onClick={() => {
                setOpen(false);
                c.run?.();
              }}
            >
              {c.hint}
              <span className={`grow ${c.strong ? "strong" : ""}`}>{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const askNodeShell = (node: string, cluster: string) =>
  ask({
    title: `Open a root shell on node ${node}?`,
    message: `A privileged pod will be created in kube-system on cluster ${cluster}, and removed when the tab is closed.`,
    ok: "Open shell",
  });

export const askDrain = (node: string, cluster: string) =>
  ask({
    title: `Drain node ${node}?`,
    message: `On cluster ${cluster}, the node will be cordoned and its pods evicted (DaemonSet pods are skipped).`,
    ok: "Drain",
    danger: true,
  });

export const askRestart = (resource: ResourceInfo, obj: KubeObject, cluster: string) =>
  ask({
    title: `Restart ${resource.kind} ${obj.metadata.name}?`,
    message: `Its pods in namespace ${obj.metadata.namespace} on cluster ${cluster} are replaced one by one.`,
    ok: "Restart",
  });

/** Object menu: the kind's own actions, then Edit and Delete. */
export function objectMenuItems(
  obj: KubeObject,
  { capi, clusterName, resource, actions, notify, askScale, copyTo, selection, openKubeconfig }: MenuContext,
): MenuItem[] {
  const id = `${resource.group}/${resource.plural}`;
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  const run = runner(notify);
  const items: MenuItem[] = [];

  if (id === "/pods") {
    const containers = [...((obj.spec?.initContainers ?? []) as any[]), ...((obj.spec?.containers ?? []) as any[])].map((c) => c.name as string);
    const perContainer = (label: string, icon: LucideIcon, open: (c?: string) => void, all?: string): MenuItem =>
      containers.length > 1
        ? {
            label,
            icon,
            children: containerItems(obj, open, all),
          }
        : { label, icon, run: () => open() };
    items.push(
      perContainer("Shell", SquareTerminal, (c) => actions.openShell(obj, c)),
      perContainer("Logs", FileText, (c) => actions.openLogs(obj, c), "All containers"),
    );
  }
  if (id === "/nodes") {
    items.push(
      {
        label: "Shell",
        icon: SquareTerminal,
        run: async () => (await askNodeShell(name, clusterName)) && actions.openNodeShell(obj),
      },
      obj.spec?.unschedulable
        ? { label: "Uncordon", icon: Play, run: run(`Uncordoned ${name}`, () => capi.nodeCordon(name, false)) }
        : { label: "Cordon", icon: Pause, run: run(`Cordoned ${name}`, () => capi.nodeCordon(name, true)) },
      {
        label: "Drain",
        icon: ArrowDownToLine,
        run: async () =>
          (await askDrain(name, clusterName)) &&
          capi.nodeDrain(name).then(
            (r) =>
              notify(
                `Drain: ${r.evicted.length} evicted, ${r.skipped.length} skipped` +
                  (r.failed.length ? `, ${r.failed.length} failed — ${r.failed.join("; ")}` : ""),
                r.failed.length ? "bad" : "ok",
              ),
            (e) => notify(String(e), "bad"),
          ),
      },
    );
  }
  if (LOG_WORKLOADS.has(id)) items.push({ label: "Logs", icon: FileText, run: () => actions.openWorkloadLogs(resource, obj) });
  if (SCALABLE.has(id)) items.push({ label: "Scale", icon: Scaling, run: () => askScale(obj) });
  if (RESTARTABLE.has(id)) {
    items.push({
      label: "Restart",
      icon: RotateCw,
      run: async () =>
        (await askRestart(resource, obj, clusterName)) && run(`Restart triggered for ${name}`, () => capi.restart(resource.key, ns, name))(),
    });
  }
  if (id === "batch/cronjobs") {
    items.push(
      {
        label: "Trigger",
        icon: Zap,
        run: () =>
          triggerCronJob(capi, obj).then(
            (job) => notify(`Created job ${job}`),
            (e) => notify(String(e), "bad"),
          ),
      },
      obj.spec?.suspend
        ? { label: "Resume", icon: Play, run: run(`Resumed ${name}`, () => capi.patch(resource.key, ns, name, { spec: { suspend: false } })) }
        : { label: "Suspend", icon: Pause, run: run(`Suspended ${name}`, () => capi.patch(resource.key, ns, name, { spec: { suspend: true } })) },
    );
  }
  if (isFlux(resource) && obj.spec) {
    items.push(
      { label: "Reconcile", icon: RefreshCw, run: run(`Reconcile requested for ${name}`, () => fluxReconcile(capi, resource, obj)) },
      obj.spec.suspend
        ? { label: "Resume", icon: Play, run: run(`Resumed ${name}`, () => fluxSuspend(capi, resource, obj, false)) }
        : { label: "Suspend", icon: Pause, run: run(`Suspended ${name}`, () => fluxSuspend(capi, resource, obj, true)) },
    );
  }
  if (id === "argoproj.io/applications") {
    items.push(
      { label: "Sync", icon: RefreshCw, run: run(`Sync started for ${name}`, () => argoSyncApp(capi, resource, obj, false)) },
      { label: "Refresh", icon: RotateCw, run: run(`Refresh requested for ${name}`, () => argoRefresh(capi, resource, obj, false)) },
    );
  }

  if (id === "networking.k8s.io/ingresses") {
    const links = ingressRoutes(obj).filter((r) => r.link);
    if (links.length === 1) items.push({ label: "Open in browser", icon: ExternalLink, run: () => api.openUrl(links[0].url) });
    else if (links.length > 1)
      items.push({ label: "Open in browser", icon: ExternalLink, children: links.map((r) => ({ label: r.url, run: () => api.openUrl(r.url) })) });
  }
  if (id === "/serviceaccounts" && openKubeconfig) items.push({ label: "Kubeconfig", icon: KeyRound, run: () => openKubeconfig(obj) });

  // What can be copied from the object; selected text, when there is some, comes first in the menu.
  const copy = (text: string, what: string) => () => copyText(text, notify, what);
  const copies: MenuItem[] = [
    { label: "Name", run: copy(name, name) },
    ...(ns ? [{ label: "Namespace/name", run: copy(`${ns}/${name}`, `${ns}/${name}`) }] : []),
    ...(id === "/events"
      ? [
          { label: "Message", run: copy(obj.message ?? "", "message") },
          { label: "Event (one line)", run: copy(eventText(obj), "event") },
        ]
      : []),
    ...(id === "/pods" && obj.status?.podIP ? [{ label: "Pod IP", run: copy(obj.status.podIP, obj.status.podIP) }] : []),
    ...(id === "/nodes"
      ? ((obj.status?.addresses ?? []) as any[]).map((a) => ({ label: `${a.type} ${a.address}`, run: copy(a.address, a.address) }))
      : []),
    {
      label: "YAML",
      run: () =>
        capi.getYaml(resource.key, ns, name).then(
          (y) => copyText(y, notify, `${resource.kind} YAML`),
          (e) => notify(String(e), "bad"),
        ),
    },
  ];
  if (selection) items.unshift({ label: "Copy", icon: Copy, run: copy(selection, "selection") });

  items.push(
    ...(copyTo ? [{ label: copyTo.count > 1 ? `Copy ${copyTo.count} to…` : "Copy to…", icon: CopyPlus, run: copyTo.run }] : []),
    { label: selection ? "Copy object…" : "Copy", icon: ClipboardCopy, children: copies },
    { label: "Edit", icon: Pencil, run: () => actions.openYaml(resource, obj) },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      run: async () => (await askDelete(resource, [obj], clusterName)) && run(`Deleted ${name}`, () => capi.delete(resource.key, ns, name))(),
    },
  );
  return items;
}

/** Tab menu: Close, Close others / all / to the left / to the right. */
export function tabMenuItems(ids: string[], id: string, close: (ids: string[], fallback?: string) => void): MenuItem[] {
  const i = ids.indexOf(id);
  const left = ids.slice(0, i);
  const right = ids.slice(i + 1);
  const others = ids.filter((x) => x !== id);
  return [
    { label: "Close", run: () => close([id]) },
    ...(others.length ? [{ label: "Close other tabs", run: () => close(others, id) }] : []),
    ...(left.length ? [{ label: "Close tabs to the left", run: () => close(left, id) }] : []),
    ...(right.length ? [{ label: "Close tabs to the right", run: () => close(right, id) }] : []),
    { label: "Close all tabs", run: () => close(ids) },
  ];
}

/** Floating menu at a point (right click) that stays inside the window. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.min(x, window.innerWidth - r.width - 6), y: Math.min(y, window.innerHeight - r.height - 6) });
  }, [x, y]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const pick = (item: MenuItem) => {
    onClose();
    item.run?.();
  };

  return (
    <div ref={ref} className={`ctx-menu ${pos.x > window.innerWidth - 420 ? "flip" : ""}`} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => (
        <div
          key={item.label}
          className={`ctx-item ${item.danger ? "danger" : ""} ${item.children ? "has-sub" : ""}`}
          onClick={() => !item.children && pick(item)}
        >
          {item.icon ? <item.icon size={15} /> : items.some((x) => x.icon) && <span className="ctx-icon" />}
          <span className="grow">{item.label}</span>
          {item.children && (
            <>
              <ChevronRight size={14} className="muted" />
              <div className="ctx-menu ctx-sub">
                {item.children.map((c) => (
                  <div key={c.label} className="ctx-item" onClick={() => pick(c)}>
                    {c.hint}
                    <span className={`grow ${c.strong ? "strong" : ""}`}>{c.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Replica count dialog for Scale. */
export function ScaleDialog({
  resource,
  obj,
  onClose,
  notify,
}: {
  resource: ResourceInfo;
  obj: KubeObject;
  onClose: () => void;
  notify: Notify;
}) {
  const capi = useApi();
  const current = obj.spec?.replicas ?? 0;
  const [replicas, setReplicas] = useState<number>(current);
  const [busy, setBusy] = useState(false);
  const apply = () => {
    setBusy(true);
    capi.scale(resource.key, obj.metadata.namespace, obj.metadata.name, replicas).then(
      () => {
        notify(`Scaled ${obj.metadata.name} to ${replicas}`);
        onClose();
      },
      (e) => {
        notify(String(e), "bad");
        setBusy(false);
      },
    );
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal scale-modal" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>
          Scale {resource.kind} {obj.metadata.name}
        </h3>
        <p className="muted">Current replicas: {current}</p>
        <div className="btn-row">
          <button onClick={() => setReplicas((r) => Math.max(0, r - 1))}>−</button>
          <input
            className="num"
            type="number"
            min={0}
            autoFocus
            value={replicas}
            onChange={(e) => setReplicas(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            onKeyDown={(e) => e.key === "Enter" && replicas !== current && apply()}
          />
          <button onClick={() => setReplicas((r) => r + 1)}>+</button>
        </div>
        <div className="btn-row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || replicas === current} onClick={apply}>
            Scale
          </button>
        </div>
      </div>
    </div>
  );
}
