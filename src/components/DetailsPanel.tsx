import { Fragment, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronsUpDown, Copy, CopyPlus, KeyRound, FileText, Pause, Pencil, Play, RotateCw, SquareTerminal, Trash2, X } from "lucide-react";
import type { KubeObject, ResourceInfo } from "../api";
import { Brick, Status } from "../columns";
import { findResource, navId } from "../nav";
import { useWatch } from "../useWatch";
import { age, podReady, podStatus, storage } from "../util";
import { ForwardControls, PortForwardDialog, useForwards } from "./PortForwards";
import { ArgoAppDetails, FluxActions, IngressDetails, NodeCharts, PodCharts, SecretData } from "./DetailsExtras";
import { isFlux } from "../gitops";
import { askDrain, askNodeShell, askRestart, containerItems, HoverMenu, LOG_WORKLOADS } from "./ObjectMenu";
import { askDelete } from "./Confirm";
import { ContainerEnv, EnvSources, useEnvSources } from "./ContainerEnv";
import { CLAIM_TEMPLATES, CLAIMS, DEVICE_CLASSES, SLICES } from "../dra";
import { useApi, useClusterName } from "../clusterContext";
import { copyText, unlessSelecting } from "../clipboard";
import {
  DeviceClassDetails,
  NodeDevices,
  PodResourceClaims,
  ResourceClaimDetails,
  ResourceClaimTemplateDetails,
  ResourceSliceDetails,
} from "./DraDetails";

export interface DockActions {
  openLogs: (pod: KubeObject, container?: string) => void;
  openShell: (pod: KubeObject, container?: string) => void;
  openYaml: (resource: ResourceInfo, obj: KubeObject) => void;
  openNodeShell: (node: KubeObject) => void;
  /** "Create resource" editor, optionally starting from a template. */
  openCreate: (yaml?: string) => void;
  /** Logs of all pods of a workload (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job). */
  openWorkloadLogs: (resource: ResourceInfo, obj: KubeObject) => void;
}

interface Props extends DockActions {
  resource: ResourceInfo;
  resources: ResourceInfo[];
  obj: KubeObject;
  onNavigate: (navId: string, uid?: string, ref?: { namespace?: string; name: string }) => void;
  onClose: () => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
  /** "Copy to…" another cluster or namespace (Secrets, ConfigMaps). */
  onCopy?: () => void;
  /** Kubeconfig for a service account. */
  onKubeconfig?: () => void;
}

const WIDTH_KEY = "detailsWidth";
const SCALABLE = new Set(["apps/deployments", "apps/statefulsets", "apps/replicasets"]);
const CONTROLLERS = new Set([
  "apps/deployments",
  "apps/statefulsets",
  "apps/daemonsets",
  "apps/replicasets",
  "batch/jobs",
  "/services",
]);
const containerCount = (pod: KubeObject) => (pod.spec?.initContainers ?? []).length + (pod.spec?.containers ?? []).length;

const RESTARTABLE = new Set(["apps/deployments", "apps/statefulsets", "apps/daemonsets"]);

/** "3 Labels ⇕" row that expands to the key=value list. */
function Collapsible({ label, data }: { label: string; data?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(data ?? {});
  return (
    <>
      <dt className={entries.length ? "toggle-dt" : ""} onClick={() => setOpen((o) => !o)}>
        {label} {entries.length > 0 && <ChevronsUpDown size={12} />}
      </dt>
      <dd>
        {!entries.length && <span className="muted">—</span>}
        {entries.length > 0 && !open && (
          <span className="link-text" onClick={() => setOpen(true)}>
            {entries.length} {entries.length === 1 ? label.slice(0, -1) : label}
          </span>
        )}
        {open && (
          <div className="chips">
            {entries.map(([k, v]) => (
              <span key={k} className="chip" title={`${k}=${v}`}>
                {k}={v}
              </span>
            ))}
          </div>
        )}
      </dd>
    </>
  );
}

function Conditions({ items }: { items?: any[] }) {
  if (!items?.length) return null;
  return (
    <section>
      <h4>Conditions</h4>
      <div className="chips">
        {items.map((c) => (
          <span key={c.type} className={`chip ${c.status === "True" ? "ok" : "muted"}`} title={c.message ?? c.reason}>
            {c.type}
          </span>
        ))}
      </div>
    </section>
  );
}

const probeText = (p?: any): string | null => {
  if (!p) return null;
  const how = p.httpGet
    ? `http-get ${p.httpGet.scheme === "HTTPS" ? "https" : "http"}://:${p.httpGet.port}${p.httpGet.path ?? "/"}`
    : p.tcpSocket
      ? `tcp-socket :${p.tcpSocket.port}`
      : p.grpc
        ? `grpc :${p.grpc.port}`
        : p.exec
          ? `exec [${(p.exec.command ?? []).join(" ")}]`
          : "probe";
  return `${how} delay=${p.initialDelaySeconds ?? 0}s timeout=${p.timeoutSeconds ?? 1}s period=${p.periodSeconds ?? 10}s #success=${p.successThreshold ?? 1} #failure=${p.failureThreshold ?? 3}`;
};

type Navigate = Props["onNavigate"];

/** One container, laid out as a card. */
function ContainerBlock({
  pod,
  c,
  actions,
  init,
  env,
  onNavigate,
}: {
  pod: KubeObject;
  c: any;
  actions: DockActions;
  init?: boolean;
  env: EnvSources;
  onNavigate: Navigate;
}) {
  const statuses = [...((pod.status?.initContainerStatuses ?? []) as any[]), ...((pod.status?.containerStatuses ?? []) as any[])];
  const st = statuses.find((x) => x.name === c.name);
  const state = st ? Object.keys(st.state ?? {})[0] : undefined;
  const term = st?.state?.terminated;
  const last = st?.lastState?.terminated;
  const running = state === "running";
  const mounts = (c.volumeMounts ?? []) as any[];
  const res = c.resources ?? {};
  const probes = [
    ["Liveness", probeText(c.livenessProbe)],
    ["Readiness", probeText(c.readinessProbe)],
    ["Startup", probeText(c.startupProbe)],
  ].filter(([, v]) => v);

  return (
    <div className="pod-container">
      <div className="pod-container-head">
        <Brick pod={pod} name={c.name} />
        <b>{c.name}</b>
        {init && <span className="chip muted">{c.restartPolicy === "Always" ? "sidecar" : "init"}</span>}
        <div className="spacer" />
        <button className="icon" title="Logs" onClick={() => actions.openLogs(pod, c.name)}>
          <FileText size={15} />
        </button>
        <button className="icon" title="Shell" disabled={!running} onClick={() => actions.openShell(pod, c.name)}>
          <SquareTerminal size={15} />
        </button>
      </div>
      <dl>
        {st && (
          <>
            <dt>Status</dt>
            <dd>
              <span className={`status ${state === "running" ? (st.ready ? "ok" : "warn") : state === "waiting" ? "warn" : term?.exitCode === 0 ? "muted" : "bad"}`}>
                {state}
                {st.ready ? ", ready" : ""}
                {term ? ` - ${term.reason ?? "Error"} (exit code: ${term.exitCode})` : ""}
                {state === "waiting" && st.state.waiting.reason ? ` - ${st.state.waiting.reason}` : ""}
              </span>
              {st.state?.waiting?.message && <div className="muted small">{st.state.waiting.message}</div>}
            </dd>
          </>
        )}
        {last && (
          <>
            <dt>Last Status</dt>
            <dd>
              terminated: {last.reason} - exit code {last.exitCode}
              <div className="muted small">
                {last.startedAt && new Date(last.startedAt).toLocaleString()} → {last.finishedAt && new Date(last.finishedAt).toLocaleString()}
              </div>
            </dd>
          </>
        )}
        {!!st?.restartCount && (
          <>
            <dt>Restarts</dt>
            <dd>{st.restartCount}</dd>
          </>
        )}
        <dt>Image</dt>
        <dd>
          <span className="badge mono" title={st?.imageID}>
            {c.image}
          </span>
        </dd>
        {c.imagePullPolicy && c.imagePullPolicy !== "IfNotPresent" && (
          <>
            <dt>ImagePullPolicy</dt>
            <dd>{c.imagePullPolicy}</dd>
          </>
        )}
        {(c.ports ?? []).length > 0 && (
          <>
            <dt>Ports</dt>
            <dd>
              {(c.ports as any[]).map((p) => (
                <div key={`${p.containerPort}/${p.protocol}`} className="mono small">
                  {p.name ? `${p.name}: ` : ""}
                  {p.containerPort}/{p.protocol ?? "TCP"}
                </div>
              ))}
            </dd>
          </>
        )}
        <ContainerEnv pod={pod} c={c} sources={env} onNavigate={onNavigate} />
        {mounts.length > 0 && <Mounts mounts={mounts} />}
        {probes.map(([name, text]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>
              <span className="badge">{text}</span>
            </dd>
          </Fragment>
        ))}
        {c.command && (
          <>
            <dt>Command</dt>
            <dd className="mono small">{(c.command as string[]).join(" ")}</dd>
          </>
        )}
        {c.args && (
          <>
            <dt>Arguments</dt>
            <dd className="mono small">{(c.args as string[]).join(" ")}</dd>
          </>
        )}
        <dt>Requests</dt>
        <dd>
          CPU: {res.requests?.cpu ?? "—"}, Memory: {res.requests?.memory ?? "—"}
        </dd>
        <dt>Limits</dt>
        <dd>
          CPU: {res.limits?.cpu ?? "—"}, Memory: {res.limits?.memory ?? "—"}
        </dd>
      </dl>
    </div>
  );
}

function Mounts({ mounts }: { mounts: any[] }) {
  const [open, setOpen] = useState(mounts.length <= 1);
  return (
    <>
      <dt className={mounts.length > 1 ? "toggle-dt" : ""} onClick={() => setOpen((o) => !o)}>
        Mounts {mounts.length > 1 && <ChevronsUpDown size={12} />}
      </dt>
      <dd>
        {!open ? (
          <span className="link-text" onClick={() => setOpen(true)}>
            {mounts.length} Mounts
          </span>
        ) : (
          mounts.map((m) => (
            <div key={m.name + m.mountPath} className="mount">
              <span className="mono small">{m.mountPath}</span>{" "}
              <span className="muted small">
                from {m.name} ({m.readOnly ? "ro" : "rw"})
              </span>
            </div>
          ))
        )}
      </dd>
    </>
  );
}

function Containers({ pod, actions, resources, onNavigate }: { pod: KubeObject; actions: DockActions; resources: ResourceInfo[]; onNavigate: Navigate }) {
  const init = (pod.spec?.initContainers ?? []) as any[];
  const env = useEnvSources(pod, resources);
  return (
    <>
      {init.length > 0 && (
        <section>
          <h4>Init Containers</h4>
          {init.map((c) => (
            <ContainerBlock key={c.name} pod={pod} c={c} actions={actions} init env={env} onNavigate={onNavigate} />
          ))}
        </section>
      )}
      <section>
        <h4>Containers</h4>
        {((pod.spec?.containers ?? []) as any[]).map((c) => (
          <ContainerBlock key={c.name} pod={pod} c={c} actions={actions} env={env} onNavigate={onNavigate} />
        ))}
      </section>
    </>
  );
}

function Ports({
  kind,
  obj,
  ports,
  notify,
}: {
  kind: "pod" | "service";
  obj: KubeObject;
  ports: { port: number; name?: string; protocol?: string }[];
  notify: Props["notify"];
}) {
  const capi = useApi();
  const forwards = useForwards(capi.cluster);
  const [dialog, setDialog] = useState<{ port: number; portName?: string } | null>(null);
  if (!ports.length) return null;
  const { namespace, name } = obj.metadata;
  const forwardOf = (port: number) =>
    forwards.find((x) => x.kind === kind && x.namespace === namespace && x.name === name && x.remotePort === port);
  return (
    <section>
      <h4>Ports</h4>
      {ports.map((p) => {
        const f = forwardOf(p.port);
        return (
          <div key={`${p.port}/${p.protocol}`} className="event-row">
            <span className="mono grow">
              {p.port}/{p.protocol ?? "TCP"} {p.name && <span className="muted">({p.name})</span>}
            </span>
            {f ? (
              <ForwardControls forward={f} onEdit={() => setDialog({ port: p.port, portName: p.name })} notify={notify} />
            ) : (
              <button
                disabled={p.protocol === "UDP"}
                title={p.protocol === "UDP" ? "UDP ports can't be forwarded" : undefined}
                onClick={() => setDialog({ port: p.port, portName: p.name })}
              >
                Forward…
              </button>
            )}
          </div>
        );
      })}
      {dialog && (
        <PortForwardDialog
          target={{ cluster: capi.cluster, kind, namespace: namespace!, name, port: dialog.port, portName: dialog.portName }}
          existing={forwardOf(dialog.port)}
          onClose={() => setDialog(null)}
          notify={notify}
        />
      )}
    </section>
  );
}

function ControlledPods({
  resources,
  obj,
  selector,
  onNavigate,
}: {
  resources: ResourceInfo[];
  obj: KubeObject;
  selector?: Record<string, string>;
  onNavigate: Props["onNavigate"];
}) {
  const labelSelector = selector && Object.keys(selector).length
    ? Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",")
    : undefined;
  const podsKey = resources.find((r) => navId(r) === "/pods")?.key;
  const pods = useWatch(labelSelector ? podsKey : undefined, obj.metadata.namespace ?? null, { labelSelector });
  if (!labelSelector) return null;
  return (
    <section>
      <h4>Pods ({pods.items.length})</h4>
      {pods.items.map((p) => {
        const [ready, total] = podReady(p);
        return (
          <div key={p.metadata.uid} className="event-row link" onClick={unlessSelecting(() => onNavigate("/pods", p.metadata.uid))}>
            <span className="grow mono small">{p.metadata.name}</span>
            <span className="small">{ready}/{total}</span>
            <Status text={podStatus(p)} />
          </div>
        );
      })}
    </section>
  );
}

/** Copies text; the icon turns into a check for a moment, like Lens' drawer title. */
function CopyButton({ text, title, notify }: { text: string; title: string; notify?: Props["notify"] }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon copy-btn"
      title={done ? "Copied!" : title}
      onClick={() =>
        copyText(text, notify, text.length > 60 ? "to clipboard" : text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function ObjectEvents({ resources, obj, notify }: { resources: ResourceInfo[]; obj: KubeObject; notify: Props["notify"] }) {
  const eventsKey = resources.find((r) => navId(r) === "/events")?.key;
  const events = useWatch(obj.metadata.uid ? eventsKey : undefined, obj.metadata.namespace ?? null, {
    fieldSelector: `involvedObject.uid=${obj.metadata.uid}`,
  });
  const sorted = [...events.items].sort(
    (a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0),
  );
  return (
    <section>
      <h4>Events ({sorted.length})</h4>
      {sorted.length === 0 && <div className="muted small">No events</div>}
      {sorted.map((e) => (
        <div key={e.metadata.uid} className={`event ${e.type === "Warning" ? "warning" : ""}`}>
          <div className="row-between small">
            <b>{e.reason}</b>
            <span className="muted event-meta">
              {e.count > 1 ? `×${e.count} · ` : ""}
              {age(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}
              <CopyButton text={`${e.reason}: ${e.message}`} title="Copy event" notify={notify} />
            </span>
          </div>
          <div className="small">{e.message}</div>
        </div>
      ))}
    </section>
  );
}

export function DetailsPanel({ resource, resources, obj, onClose, onNavigate, notify, onCopy, onKubeconfig, ...actions }: Props) {
  const capi = useApi();
  const id = `${resource.group}/${resource.plural}`;
  const [replicas, setReplicas] = useState<number>(obj.spec?.replicas ?? 0);
  const [busy, setBusy] = useState(false);
  const ns = obj.metadata.namespace;
  const [width, setWidth] = useState(() => Number(storage.get(WIDTH_KEY)) || 560);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      notify(label, "ok");
    } catch (e) {
      notify(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const clusterName = useClusterName();
  const remove = async () => {
    if (!(await askDelete(resource, [obj], clusterName))) return;
    run(`Deleted ${obj.metadata.name}`, () => capi.delete(resource.key, ns, obj.metadata.name)).then(onClose);
  };

  return (
    <aside className="details" style={{ width }}>
      <div
        className="details-resizer"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setWidth(Math.min(Math.max(drag.current.w - (e.clientX - drag.current.x), 360), window.innerWidth - 480));
        }}
        onPointerUp={() => {
          drag.current = null;
          storage.set(WIDTH_KEY, String(width));
        }}
      />
      <header className="details-head">
        <h3 title={`${resource.kind}: ${obj.metadata.name}`}>
          {resource.kind}: {obj.metadata.name}
        </h3>
        <CopyButton text={obj.metadata.name} title="Copy name" notify={notify} />
        <div className="details-actions">
          {id === "/pods" &&
            (containerCount(obj) > 1 ? (
              <>
                <HoverMenu icon={FileText} title="Logs" onClick={() => actions.openLogs(obj)} items={containerItems(obj, (c) => actions.openLogs(obj, c), "All containers")} />
                <HoverMenu icon={SquareTerminal} title="Shell" onClick={() => actions.openShell(obj)} items={containerItems(obj, (c) => actions.openShell(obj, c))} />
              </>
            ) : (
              <>
                <button className="icon" title="Logs" onClick={() => actions.openLogs(obj)}>
                  <FileText size={16} />
                </button>
                <button className="icon" title="Shell" onClick={() => actions.openShell(obj)}>
                  <SquareTerminal size={16} />
                </button>
              </>
            ))}
          {LOG_WORKLOADS.has(id) && (
            <button className="icon" title="Logs of all pods" onClick={() => actions.openWorkloadLogs(resource, obj)}>
              <FileText size={16} />
            </button>
          )}
          {id === "/nodes" && (
            <button
              className="icon"
              title="Node shell — runs a privileged pod in kube-system on this node; it is deleted when the tab closes"
              onClick={async () => (await askNodeShell(obj.metadata.name, clusterName)) && actions.openNodeShell(obj)}
            >
              <SquareTerminal size={16} />
            </button>
          )}
          {RESTARTABLE.has(id) && (
            <button
              className="icon"
              title="Restart"
              disabled={busy}
              onClick={async () =>
                (await askRestart(resource, obj, clusterName)) && run("Restart triggered", () => capi.restart(resource.key, ns, obj.metadata.name))
              }
            >
              <RotateCw size={16} />
            </button>
          )}
          {id === "/nodes" &&
            (obj.spec?.unschedulable ? (
              <button className="icon" title="Uncordon" disabled={busy} onClick={() => run("Uncordoned", () => capi.nodeCordon(obj.metadata.name, false))}>
                <Play size={16} />
              </button>
            ) : (
              <button className="icon" title="Cordon" disabled={busy} onClick={() => run("Cordoned", () => capi.nodeCordon(obj.metadata.name, true))}>
                <Pause size={16} />
              </button>
            ))}
          {id === "/nodes" && (
            <button
              className="icon"
              title="Drain"
              disabled={busy}
              onClick={async () => {
                if (!(await askDrain(obj.metadata.name, clusterName))) return;
                setBusy(true);
                capi
                  .nodeDrain(obj.metadata.name)
                  .then((r) =>
                    notify(
                      `Drain: ${r.evicted.length} evicted, ${r.skipped.length} skipped` +
                        (r.failed.length ? `, ${r.failed.length} failed — ${r.failed.join("; ")}` : ""),
                      r.failed.length ? "bad" : "ok",
                    ),
                  )
                  .catch((e) => notify(String(e), "bad"))
                  .finally(() => setBusy(false));
              }}
            >
              <ArrowDownToLine size={16} />
            </button>
          )}
          {onKubeconfig && (
            <button className="icon" title="Kubeconfig for this service account" onClick={onKubeconfig}>
              <KeyRound size={16} />
            </button>
          )}
          {onCopy && (
            <button className="icon" title="Copy to another cluster or namespace" onClick={onCopy}>
              <CopyPlus size={16} />
            </button>
          )}
          <button className="icon" title="Edit YAML" onClick={() => actions.openYaml(resource, obj)}>
            <Pencil size={16} />
          </button>
          <button className="icon" title="Delete" disabled={busy} onClick={remove}>
            <Trash2 size={16} />
          </button>
          <button className="icon" onClick={onClose} title="Close (Esc)">
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="details-body">

      {SCALABLE.has(id) && (
        <section>
          <h4>Scale</h4>
          <div className="btn-row">
            <button onClick={() => setReplicas((r) => Math.max(0, r - 1))}>−</button>
            <input
              className="num"
              type="number"
              min={0}
              value={replicas}
              onChange={(e) => setReplicas(Math.max(0, Number(e.target.value)))}
            />
            <button onClick={() => setReplicas((r) => r + 1)}>+</button>
            <button
              className="primary"
              disabled={busy || replicas === obj.spec?.replicas}
              onClick={() =>
                run(`Scaled to ${replicas}`, () => capi.scale(resource.key, ns, obj.metadata.name, replicas))
              }
            >
              Apply
            </button>
          </div>
        </section>
      )}

      <section className="meta">
        <h4>Properties</h4>
        <dl>
          <dt>Name</dt>
          <dd>{obj.metadata.name}</dd>
          {ns && (
            <>
              <dt>Namespace</dt>
              <dd>{ns}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>
            {age(obj.metadata.creationTimestamp)} ago{" "}
            <span className="muted">({obj.metadata.creationTimestamp && new Date(obj.metadata.creationTimestamp).toLocaleString()})</span>
          </dd>
          <dt>UID</dt>
          <dd className="mono small">{obj.metadata.uid}</dd>
          {id === "/pods" && (
            <>
              <dt>Status</dt>
              <dd>
                <Status text={podStatus(obj)} />
              </dd>
              <dt>Node</dt>
              <dd>{obj.spec?.nodeName ?? "—"}</dd>
              <dt>Pod IP</dt>
              <dd>{obj.status?.podIP ?? "—"}</dd>
            </>
          )}
          {obj.metadata.ownerReferences?.length ? (
            <>
              <dt>Controlled by</dt>
              <dd>
                {obj.metadata.ownerReferences.map((r) => {
                  const owner = findResource(resources, r.apiVersion, r.kind);
                  return owner ? (
                    <a
                      key={r.uid}
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        onNavigate(navId(owner), r.uid);
                      }}
                    >
                      {r.kind}/{r.name}{" "}
                    </a>
                  ) : (
                    <span key={r.uid}>{r.kind}/{r.name} </span>
                  );
                })}
              </dd>
            </>
          ) : null}
          <Collapsible label="Labels" data={obj.metadata.labels} />
          <Collapsible label="Annotations" data={obj.metadata.annotations} />
        </dl>
      </section>

      <Conditions items={obj.status?.conditions} />
      {id === "/pods" && <Containers pod={obj} actions={actions} resources={resources} onNavigate={onNavigate} />}
      {id === "/pods" && <PodResourceClaims pod={obj} resources={resources} onNavigate={onNavigate} />}
      {id === CLAIMS && <ResourceClaimDetails obj={obj} onNavigate={onNavigate} />}
      {id === CLAIM_TEMPLATES && <ResourceClaimTemplateDetails obj={obj} onNavigate={onNavigate} />}
      {id === DEVICE_CLASSES && <DeviceClassDetails obj={obj} />}
      {id === SLICES && <ResourceSliceDetails obj={obj} resources={resources} onNavigate={onNavigate} />}
      {id === "/nodes" && <NodeDevices node={obj} resources={resources} onNavigate={onNavigate} />}
      {id === "/pods" && (
        <Ports
          kind="pod"
          obj={obj}
          notify={notify}
          ports={((obj.spec?.containers ?? []) as any[]).flatMap((c) =>
            ((c.ports ?? []) as any[]).map((p) => ({ port: p.containerPort, name: p.name, protocol: p.protocol })),
          )}
        />
      )}
      {id === "/services" && obj.spec?.selector && (
        <Ports kind="service" obj={obj} notify={notify} ports={(obj.spec?.ports ?? []) as any[]} />
      )}
      {CONTROLLERS.has(id) && (
        <ControlledPods
          resources={resources}
          obj={obj}
          selector={id === "/services" ? obj.spec?.selector : obj.spec?.selector?.matchLabels}
          onNavigate={onNavigate}
        />
      )}
      {isFlux(resource) && <FluxActions resource={resource} resources={resources} obj={obj} notify={notify} />}
      {id === "argoproj.io/applications" && (
        <ArgoAppDetails resource={resource} resources={resources} obj={obj} notify={notify} onNavigate={onNavigate} />
      )}
      {id === "networking.k8s.io/ingresses" && <IngressDetails obj={obj} onNavigate={onNavigate} />}
      {id === "/secrets" && <SecretData obj={obj} notify={notify} />}
      {id === "/pods" && <PodCharts pod={obj} />}
      {id === "/nodes" && <NodeCharts node={obj} />}
      <ObjectEvents resources={resources} obj={obj} notify={notify} />
      </div>
    </aside>
  );
}
