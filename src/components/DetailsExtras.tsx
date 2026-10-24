import { useState } from "react";
import type { KubeObject, ResourceInfo } from "../api";
import { Status } from "../columns";
import {
  argoHealth,
  argoOperation,
  argoRefresh,
  argoSync,
  argoSyncApp,
  fluxMessage,
  fluxReconcile,
  fluxRevision,
  fluxSourceTarget,
  fluxState,
  fluxSuspend,
  openArgoUi,
} from "../gitops";
import { navId } from "../nav";
import { formatBytes, formatCpu } from "../util";
import { PromChart, promQueries, useMetricsHidden, usePrometheusAvailable } from "./Charts";
import { forwardsChanged } from "./PortForwards";
import { useApi } from "../clusterContext";
import { unlessSelecting } from "../clipboard";

type Notify = (msg: string, tone?: "ok" | "bad") => void;
type Navigate = (navId: string, uid?: string, ref?: { namespace?: string; name: string }) => void;

function useRunner(notify: Notify) {
  const [busy, setBusy] = useState(false);
  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      notify(label);
    } catch (e) {
      notify(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function FluxActions({
  resource,
  resources,
  obj,
  notify,
}: {
  resource: ResourceInfo;
  resources: ResourceInfo[];
  obj: KubeObject;
  notify: Notify;
}) {
  const capi = useApi();
  const { busy, run } = useRunner(notify);
  const source = fluxSourceTarget(resources, obj);
  const suspended = !!obj.spec?.suspend;
  const hasSpec = !!obj.spec;
  return (
    <section>
      <h4>Flux</h4>
      <dl>
        <dt>Status</dt>
        <dd>
          <Status text={fluxState(obj)} />
        </dd>
        {fluxRevision(obj) && (
          <>
            <dt>Revision</dt>
            <dd className="mono small">{fluxRevision(obj)}</dd>
          </>
        )}
        {fluxMessage(obj) && (
          <>
            <dt>Message</dt>
            <dd className="small">{fluxMessage(obj)}</dd>
          </>
        )}
        {obj.status?.lastHandledReconcileAt && (
          <>
            <dt>Last reconcile request</dt>
            <dd className="small">{obj.status.lastHandledReconcileAt}</dd>
          </>
        )}
      </dl>
      <div className="btn-row">
        <button disabled={busy || suspended} onClick={() => run("Reconcile requested", () => fluxReconcile(capi, resource, obj))}>
          Reconcile
        </button>
        {source && (
          <button
            disabled={busy || suspended}
            title={`Also reconcile ${source.res.kind}/${source.obj.metadata.name}`}
            onClick={() =>
              run("Reconcile with source requested", async () => {
                await fluxReconcile(capi, source.res, source.obj);
                await fluxReconcile(capi, resource, obj);
              })
            }
          >
            Reconcile with source
          </button>
        )}
        {hasSpec && (
          <button
            disabled={busy}
            onClick={() => run(suspended ? "Resumed" : "Suspended", () => fluxSuspend(capi, resource, obj, !suspended))}
          >
            {suspended ? "Resume" : "Suspend"}
          </button>
        )}
      </div>
    </section>
  );
}

export function ArgoAppDetails({
  resource,
  resources,
  obj,
  notify,
  onNavigate,
}: {
  resource: ResourceInfo;
  resources: ResourceInfo[];
  obj: KubeObject;
  notify: Notify;
  onNavigate: Navigate;
}) {
  const capi = useApi();
  const { busy, run } = useRunner(notify);
  const [prune, setPrune] = useState(false);
  const op = obj.status?.operationState;
  const managed = (obj.status?.resources ?? []) as any[];
  const conditions = (obj.status?.conditions ?? []) as any[];
  const findRes = (group: string, kind: string) => resources.find((r) => r.group === (group ?? "") && r.kind === kind);

  return (
    <>
      <section>
        <h4>Argo CD</h4>
        <dl>
          <dt>Sync</dt>
          <dd>
            <Status text={argoSync(obj)} />{" "}
            <span className="mono small muted">{obj.status?.sync?.revision?.slice(0, 12)}</span>
          </dd>
          <dt>Health</dt>
          <dd>
            <Status text={argoHealth(obj)} /> <span className="small muted">{obj.status?.health?.message}</span>
          </dd>
          {op && (
            <>
              <dt>Last operation</dt>
              <dd className="small">
                <Status text={argoOperation(obj)} /> {op.message}
              </dd>
            </>
          )}
        </dl>
        <div className="btn-row">
          <button disabled={busy} className="primary" onClick={() => run("Sync started", () => argoSyncApp(capi, resource, obj, prune))}>
            Sync
          </button>
          <label className="small muted">
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} /> prune
          </label>
          <button disabled={busy} onClick={() => run("Refresh requested", () => argoRefresh(capi, resource, obj, false))}>
            Refresh
          </button>
          <button disabled={busy} onClick={() => run("Hard refresh requested", () => argoRefresh(capi, resource, obj, true))}>
            Hard refresh
          </button>
          <button
            disabled={busy}
            onClick={() =>
              run("Argo CD UI opened", async () => {
                await openArgoUi(capi, obj.metadata.namespace ?? "argocd");
                forwardsChanged();
              })
            }
          >
            Open UI
          </button>
        </div>
      </section>
      {conditions.length > 0 && (
        <section>
          <h4>App conditions</h4>
          {conditions.map((c, i) => (
            <div key={i} className="event warning">
              <b className="small">{c.type}</b>
              <div className="small">{c.message}</div>
            </div>
          ))}
        </section>
      )}
      <section>
        <h4>Resources ({managed.length})</h4>
        {managed.map((m) => {
          const res = findRes(m.group, m.kind);
          return (
            <div
              key={`${m.group}/${m.kind}/${m.namespace}/${m.name}`}
              className={`event-row ${res ? "link" : ""}`}
              onClick={unlessSelecting(() => res && onNavigate(navId(res), undefined, { namespace: m.namespace, name: m.name }))}
            >
              <span className="chip">{m.kind}</span>
              <span className="grow mono small">
                {m.namespace ? `${m.namespace}/` : ""}
                {m.name}
              </span>
              {m.status && <Status text={m.status} />}
              {m.health?.status && <Status text={m.health.status} />}
            </div>
          );
        })}
      </section>
    </>
  );
}

const decodeB64 = (v: string) => {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
  } catch {
    return "<binary>";
  }
};

export function SecretData({ obj, notify }: { obj: KubeObject; notify: Notify }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const entries = Object.entries((obj.data ?? {}) as Record<string, string>);
  if (!entries.length) return null;
  return (
    <section>
      <h4>Data</h4>
      {entries.map(([k, v]) => (
        <div key={k} className="secret-row">
          <div className="row-between">
            <span className="mono small">{k}</span>
            <span className="btn-row">
              <button className="icon" onClick={() => setShown((s) => ({ ...s, [k]: !s[k] }))}>
                {shown[k] ? "Hide" : "Show"}
              </button>
              <button
                className="icon"
                onClick={() => navigator.clipboard.writeText(decodeB64(v)).then(() => notify(`Copied ${k}`))}
              >
                Copy
              </button>
            </span>
          </div>
          <pre className="secret-value">{shown[k] ? decodeB64(v) : "••••••••"}</pre>
        </div>
      ))}
    </section>
  );
}

export function PodCharts({ pod }: { pod: KubeObject }) {
  const ns = pod.metadata.namespace!;
  const name = pod.metadata.name;
  const hidden = useMetricsHidden("pod");
  const prometheus = usePrometheusAvailable();
  if (hidden || prometheus !== true) return null;
  return (
    <section>
      <h4>Metrics (Prometheus)</h4>
      <PromChart
        title="CPU"
        format={formatCpu}
        queries={[
          { label: "usage", query: promQueries.podCpu(ns, name), color: "#3d90ce" },
          { label: "requests", query: promQueries.podCpuReq(ns, name), color: "#8e98a3" },
        ]}
      />
      <PromChart
        title="Memory"
        format={formatBytes}
        queries={[
          { label: "usage", query: promQueries.podMem(ns, name), color: "#7a4dff" },
          { label: "requests", query: promQueries.podMemReq(ns, name), color: "#8e98a3" },
        ]}
      />
    </section>
  );
}

export function NodeCharts({ node }: { node: KubeObject }) {
  const name = node.metadata.name;
  const hidden = useMetricsHidden("node");
  const prometheus = usePrometheusAvailable();
  if (hidden || prometheus !== true) return null;
  return (
    <section>
      <h4>Metrics (Prometheus)</h4>
      <PromChart title="CPU" format={formatCpu} queries={[{ label: "usage", query: promQueries.nodeCpu(name), color: "#3d90ce" }]} />
      <PromChart
        title="Memory"
        format={formatBytes}
        queries={[{ label: "usage", query: promQueries.nodeMem(name), color: "#7a4dff" }]}
      />
    </section>
  );
}
