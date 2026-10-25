import { useMemo } from "react";
import type { Connection, KubeObject } from "../api";
import { Status } from "../columns";
import { findResource, navId, pluralTitle } from "../nav";
import { useWatch } from "../useWatch";
import { age } from "../util";
import { countStates, OVERVIEW_KINDS, podStatesByOwner, STATE_COLORS, WorkloadState, workloadState } from "../workloads";
import type { Navigate } from "./ClusterView";
import { NamespaceSelect } from "./NamespaceSelect";

const MAX_EVENTS = 100;
const EVENT_COLS = "90px minmax(260px, 1fr) minmax(160px, 260px) 70px 90px";
const eventTime = (e: KubeObject) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? "") || 0;

/** Lens' Workloads → Overview: a status chart per workload kind, and the latest events. */
export function WorkloadsOverview({ conn, namespace, onNavigate }: { conn: Connection; namespace: string | null; onNavigate: Navigate }) {
  const byId = useMemo(() => new Map(conn.resources.map((r) => [navId(r), r])), [conn]);
  // One watch per kind; the kinds are fixed, so the hooks are always called in the same order.
  const watches = OVERVIEW_KINDS.map(({ id }) => useWatch(byId.get(id)?.key, namespace));
  const events = useWatch(byId.get("/events")?.key, namespace);

  const pods = watches[0].items;
  const replicaSets = watches[OVERVIEW_KINDS.findIndex((k) => k.kind === "ReplicaSet")].items;
  const owners = useMemo(() => podStatesByOwner(pods, replicaSets), [pods, replicaSets]);

  const recent = useMemo(() => [...events.items].sort((a, b) => eventTime(b) - eventTime(a)).slice(0, MAX_EVENTS), [events.items]);

  return (
    <div className="overview">
      <div className="view-head">
        <h2>Workloads Overview</h2>
        <div className="spacer" />
        <NamespaceSelect />
      </div>

      <div className="wo-grid">
        {OVERVIEW_KINDS.map(({ id, kind }, i) => {
          const resource = byId.get(id);
          if (!resource) return null;
          const { items, error } = watches[i];
          const counts = countStates(items.map((o) => workloadState(kind, o, owners.get(o.metadata.uid ?? ""))));
          return (
            <StatusCard
              key={id}
              title={pluralTitle(resource)}
              total={items.length}
              counts={counts}
              error={error}
              onOpen={() => onNavigate(id)}
            />
          );
        })}
      </div>

      <div className="ov-warnings">
        <div className="wo-events-head">
          <h3>Events</h3>
          <span className="muted small">
            {events.items.length > recent.length ? `latest ${recent.length} of ${events.items.length}` : events.items.length}
          </span>
          <div className="spacer" />
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onNavigate("/events");
            }}
          >
            Show all
          </a>
        </div>
        {recent.length === 0 ? (
          <div className="muted wo-empty">{events.loading ? "Loading…" : (events.error ?? "No events.")}</div>
        ) : (
          <div className="table plain">
            <div className="tr th" style={{ gridTemplateColumns: EVENT_COLS }}>
              <div className="td">Type</div>
              <div className="td">Message</div>
              <div className="td">Object</div>
              <div className="td">Count</div>
              <div className="td">Last seen</div>
            </div>
            {recent.map((e) => {
              const o = e.involvedObject ?? {};
              const target = findResource(conn.resources, o.apiVersion, o.kind);
              return (
                <div key={e.metadata.uid} className="tr" style={{ gridTemplateColumns: EVENT_COLS }} title={e.message}>
                  <div className="td">
                    <Status text={e.type ?? ""} />
                  </div>
                  <div className="td">
                    <b>{e.reason}</b> {e.message}
                  </div>
                  <div className="td">
                    {target ? (
                      <a
                        href="#"
                        onClick={(ev) => {
                          ev.preventDefault();
                          onNavigate(navId(target), undefined, { namespace: o.namespace, name: o.name });
                        }}
                      >
                        {o.kind}/{o.name}
                      </a>
                    ) : (
                      `${o.kind}/${o.name}`
                    )}
                  </div>
                  <div className="td">{e.count ?? 1}</div>
                  <div className="td">{age(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  title,
  total,
  counts,
  error,
  onOpen,
}: {
  title: string;
  total: number;
  counts: [WorkloadState, number][];
  error?: string;
  onOpen: () => void;
}) {
  return (
    <div className="wo-card">
      <a
        href="#"
        className="wo-title"
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
      >
        {title} ({total})
      </a>
      <div className="wo-body">
        <Donut counts={counts} total={total} />
        <div className="ring-legend">
          {counts.map(([state, n]) => (
            <div key={state}>
              <i style={{ background: STATE_COLORS[state] }} /> {state}: {n}
            </div>
          ))}
          {!counts.length && (
            <div className="muted" title={error}>
              {error ? "Not available" : "None"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A ring split by state, with the total in the middle. */
function Donut({ counts, total }: { counts: [WorkloadState, number][]; total: number }) {
  const size = 92;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut">
      <circle cx={center} cy={center} r={r} className="ring-track" strokeWidth={stroke} fill="none" />
      {counts.map(([state, n]) => {
        const len = (n / total) * c;
        const arc = (
          <circle
            key={state}
            cx={center}
            cy={center}
            r={r}
            fill="none"
            strokeWidth={stroke}
            style={{ stroke: STATE_COLORS[state] }}
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${center} ${center})`}
          >
            <title>
              {state}: {n}
            </title>
          </circle>
        );
        offset += len;
        return arc;
      })}
      <text x={center} y={center} textAnchor="middle" dominantBaseline="central" className="donut-total">
        {total}
      </text>
    </svg>
  );
}
