import { useState } from "react";
import type { Connection, KubeObject, ResourceInfo } from "../api";
import { Status } from "../columns";
import {
  argoHealth,
  argoNeedsAttention,
  argoOperation,
  argoResources,
  argoSourceText,
  argoSync,
  fluxMessage,
  fluxNeedsAttention,
  fluxResources,
  fluxState,
  openArgoUi,
} from "../gitops";
import { navId, pluralTitle } from "../nav";
import { useWatchMany } from "../useWatch";
import { age } from "../util";
import { forwardsChanged } from "./PortForwards";
import { NamespaceSelect } from "./NamespaceSelect";
import { useApi } from "../clusterContext";
import { unlessSelecting } from "../clipboard";

interface Props {
  conn: Connection;
  namespace: string | null;
  onNavigate: (navId: string, uid?: string) => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}

const lastChange = (o: KubeObject): string =>
  ((o.status?.conditions ?? []) as any[]).map((c) => c.lastTransitionTime).sort().at(-1) ??
  o.status?.reconciledAt ??
  o.metadata.creationTimestamp ??
  "";

function Empty({ what }: { what: string }) {
  return (
    <div className="overview">
      <h2>{what}</h2>
      <div className="panel muted">{what} CRDs were not found in this cluster.</div>
    </div>
  );
}

export function FluxDashboard({ conn, namespace, onNavigate }: Props) {
  const kinds = fluxResources(conn.resources);
  const data = useWatchMany(kinds.map((k) => k.key), namespace);
  if (!kinds.length) return <Empty what="Flux" />;

  const rows: { res: ResourceInfo; obj: KubeObject }[] = kinds.flatMap((res) =>
    (data[res.key]?.items ?? []).map((obj) => ({ res, obj })),
  );
  const attention = rows.filter((r) => fluxNeedsAttention(r.obj));
  const suspended = rows.filter((r) => fluxState(r.obj) === "Suspended");
  const recent = [...rows].sort((a, b) => lastChange(b.obj).localeCompare(lastChange(a.obj))).slice(0, 15);

  return (
    <div className="overview">
      <div className="view-head">
        <h2>Flux</h2>
        <div className="spacer" />
        <NamespaceSelect />
      </div>
      <div className={`banner ${attention.length ? "bad" : "ok"}`}>
        {attention.length
          ? `${attention.length} Flux object(s) failing or stalled`
          : `All ${rows.length} Flux objects are healthy${suspended.length ? ` (${suspended.length} suspended)` : ""}`}
      </div>

      <div className="stats">
        {kinds.map((res) => {
          const items = data[res.key]?.items ?? [];
          const failed = items.filter(fluxNeedsAttention).length;
          if (!items.length) return null;
          return (
            <button key={res.key} className="stat" onClick={() => onNavigate(navId(res))}>
              <div className={`stat-value ${failed ? "bad" : "ok"}`}>
                {items.length - failed}/{items.length}
              </div>
              <div className="muted small">{pluralTitle(res)}</div>
            </button>
          );
        })}
      </div>

      <div className="panel">
        <h4>Needs attention</h4>
        {attention.length === 0 && <div className="muted">Nothing is failing 🎉</div>}
        {attention.map(({ res, obj }) => (
          <ObjRow key={obj.metadata.uid} res={res} obj={obj} onNavigate={onNavigate} state={fluxState(obj)} message={fluxMessage(obj)} />
        ))}
      </div>

      {suspended.length > 0 && (
        <div className="panel">
          <h4>Suspended</h4>
          {suspended.map(({ res, obj }) => (
            <ObjRow key={obj.metadata.uid} res={res} obj={obj} onNavigate={onNavigate} state="Suspended" message="" />
          ))}
        </div>
      )}

      <div className="panel">
        <h4>Recent activity</h4>
        {recent.map(({ res, obj }) => (
          <ObjRow
            key={obj.metadata.uid}
            res={res}
            obj={obj}
            onNavigate={onNavigate}
            state={fluxState(obj)}
            message={fluxMessage(obj)}
            when={lastChange(obj)}
          />
        ))}
      </div>
    </div>
  );
}

function ObjRow({
  res,
  obj,
  state,
  message,
  when,
  onNavigate,
}: {
  res: ResourceInfo;
  obj: KubeObject;
  state: string;
  message: string;
  when?: string;
  onNavigate: Props["onNavigate"];
}) {
  return (
    <div className="event-row link" onClick={unlessSelecting(() => onNavigate(navId(res), obj.metadata.uid))}>
      <Status text={state} />
      <span className="chip">{res.kind}</span>
      <span className="mono small">
        {obj.metadata.namespace ? `${obj.metadata.namespace}/` : ""}
        {obj.metadata.name}
      </span>
      <span className="grow small muted" title={message}>
        {message}
      </span>
      {when && <span className="muted small">{age(when)}</span>}
    </div>
  );
}

export function ArgoDashboard({ conn, namespace, onNavigate, notify }: Props) {
  const capi = useApi();
  const kinds = argoResources(conn.resources);
  const appRes = kinds.find((k) => k.plural === "applications");
  const data = useWatchMany(appRes ? [appRes.key] : [], namespace);
  const [busy, setBusy] = useState(false);
  if (!appRes) return <Empty what="Argo CD" />;

  const apps = data[appRes.key]?.items ?? [];
  const count = (f: (o: KubeObject) => boolean) => apps.filter(f).length;
  const attention = apps.filter(argoNeedsAttention);
  const argoNs = apps[0]?.metadata.namespace ?? "argocd";

  return (
    <div className="overview">
      <div className="view-head">
        <h2>Argo CD</h2>
        <div className="spacer" />
        <NamespaceSelect />
        <button
          disabled={busy}
          title={`Port-forward ${argoNs}/argocd-server and open it`}
          onClick={async () => {
            setBusy(true);
            try {
              await openArgoUi(capi, argoNs);
              forwardsChanged();
            } catch (e) {
              notify(String(e), "bad");
            } finally {
              setBusy(false);
            }
          }}
        >
          Open Argo CD UI
        </button>
      </div>

      <div className="stats">
        <button className="stat" onClick={() => onNavigate(navId(appRes))}>
          <div className="stat-value">{apps.length}</div>
          <div className="muted small">Applications</div>
        </button>
        <div className="stat">
          <div className="stat-value ok">{count((o) => argoSync(o) === "Synced")}</div>
          <div className="muted small">Synced</div>
        </div>
        <div className="stat">
          <div className="stat-value warn">{count((o) => argoSync(o) === "OutOfSync")}</div>
          <div className="muted small">OutOfSync</div>
        </div>
        <div className="stat">
          <div className="stat-value ok">{count((o) => argoHealth(o) === "Healthy")}</div>
          <div className="muted small">Healthy</div>
        </div>
        <div className="stat">
          <div className="stat-value warn">{count((o) => argoHealth(o) === "Progressing")}</div>
          <div className="muted small">Progressing</div>
        </div>
        <div className="stat">
          <div className="stat-value bad">{count((o) => /^(Degraded|Missing)$/.test(argoHealth(o)))}</div>
          <div className="muted small">Degraded / Missing</div>
        </div>
      </div>

      <div className="panel">
        <h4>Needs attention</h4>
        {attention.length === 0 && <div className="muted">All applications are synced and healthy 🎉</div>}
        {attention.map((o) => (
          <AppRow key={o.metadata.uid} app={o} onClick={() => onNavigate(navId(appRes), o.metadata.uid)} />
        ))}
      </div>

      <div className="panel">
        <h4>Applications</h4>
        {apps
          .slice()
          .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
          .map((o) => (
            <AppRow key={o.metadata.uid} app={o} onClick={() => onNavigate(navId(appRes), o.metadata.uid)} />
          ))}
      </div>
    </div>
  );
}

function AppRow({ app, onClick }: { app: KubeObject; onClick: () => void }) {
  const op = argoOperation(app);
  return (
    <div className="event-row link" onClick={unlessSelecting(onClick)}>
      <span className="mono small app-name">{app.metadata.name}</span>
      <Status text={argoSync(app)} />
      <Status text={argoHealth(app)} />
      {op && op !== "Succeeded" && <Status text={op} />}
      <span className="grow small muted">{argoSourceText(app)}</span>
      <span className="muted small">{age(app.status?.reconciledAt ?? app.metadata.creationTimestamp)}</span>
    </div>
  );
}
