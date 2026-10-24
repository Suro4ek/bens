import { Fragment } from "react";
import type { KubeObject, ResourceInfo } from "../api";
import {
  allocatedDevices,
  allocationMap,
  CLAIMS,
  claimState,
  classDrivers,
  containersUsingClaim,
  DEVICE_CLASSES,
  deviceKey,
  DeviceRequest,
  deviceRequests,
  podClaimNames,
  SLICES,
  SliceDevice,
  sliceDevices,
  sliceNode,
} from "../dra";
import { navId } from "../nav";
import { useWatch } from "../useWatch";
import { statusTone } from "../util";
import { unlessSelecting } from "../clipboard";

type Navigate = (navId: string, uid?: string, ref?: { namespace?: string; name: string }) => void;

const keyOf = (resources: ResourceInfo[], id: string) => resources.find((r) => navId(r) === id)?.key;

function Link({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {children}
    </a>
  );
}

function Requests({ requests, onNavigate }: { requests: DeviceRequest[]; onNavigate: Navigate }) {
  if (!requests.length) return null;
  return (
    <section className="meta">
      <h4>Requests</h4>
      <dl>
        {requests.map((r) => (
          <Fragment key={r.name}>
            <dt>{r.name}</dt>
            <dd>
              {r.classes.map((c, i) => (
                <Fragment key={c}>
                  {i > 0 && " | "}
                  <Link onClick={() => onNavigate(DEVICE_CLASSES, undefined, { name: c })}>{c}</Link>
                </Fragment>
              ))}
              <span className="muted"> · count: {r.mode}</span>
              {r.adminAccess && <span className="chip">admin access</span>}
              {r.selectors.map((s) => (
                <div key={s} className="mono small">
                  {s}
                </div>
              ))}
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function Conditions({ conditions }: { conditions: any[] }) {
  return (
    <span className="chips">
      {conditions.map((c) => (
        <span
          key={c.type}
          className={`chip ${c.status === "True" ? (/fail|error|unhealthy|degraded/i.test(c.type) ? "bad" : "ok") : "muted"}`}
          title={c.message}
        >
          {c.type}
        </span>
      ))}
    </span>
  );
}

export function ResourceClaimDetails({ obj, onNavigate }: { obj: KubeObject; onNavigate: Navigate }) {
  const results = allocatedDevices(obj);
  const statuses = (obj.status?.devices ?? []) as any[];
  const reserved = (obj.status?.reservedFor ?? []) as any[];
  return (
    <>
      <Requests requests={deviceRequests(obj.spec)} onNavigate={onNavigate} />
      <section className="meta">
        <h4>Allocation</h4>
        <dl>
          <dt>State</dt>
          <dd>
            <span className={`status ${statusTone(obj.status?.allocation ? "Active" : "Pending")}`}>{claimState(obj)}</span>
          </dd>
          {results.map((r) => (
            <Fragment key={`${r.request}/${deviceKey(r)}`}>
              <dt>{r.request}</dt>
              <dd className="mono small">
                {r.driver} / {r.pool} / {r.device}
              </dd>
            </Fragment>
          ))}
          {statuses
            .filter((s) => s.conditions?.length || s.networkData)
            .map((s) => (
              <Fragment key={deviceKey(s)}>
                <dt>{s.device}</dt>
                <dd>
                  <Conditions conditions={s.conditions ?? []} />
                  {s.networkData && (
                    <div className="small">
                      {[s.networkData.interfaceName, ...(s.networkData.ips ?? []), s.networkData.hardwareAddress].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </dd>
              </Fragment>
            ))}
        </dl>
      </section>
      {reserved.length > 0 && (
        <section>
          <h4>Reserved for</h4>
          {reserved.map((r) => (
            <div
              key={r.uid}
              className={`event-row ${r.resource === "pods" ? "link" : ""}`}
              onClick={unlessSelecting(() => r.resource === "pods" && onNavigate("/pods", r.uid))}
            >
              <span className="muted small">{r.resource}</span>
              <span className="grow mono small">{r.name}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

export function ResourceClaimTemplateDetails({ obj, onNavigate }: { obj: KubeObject; onNavigate: Navigate }) {
  return <Requests requests={deviceRequests(obj.spec?.spec)} onNavigate={onNavigate} />;
}

export function DeviceClassDetails({ obj }: { obj: KubeObject }) {
  const selectors = ((obj.spec?.selectors ?? []) as any[]).map((s) => s.cel?.expression).filter(Boolean);
  const drivers = classDrivers(obj);
  const extended = obj.spec?.extendedResourceName;
  if (!selectors.length && !drivers && !extended) return null;
  return (
    <section className="meta">
      <h4>Device class</h4>
      <dl>
        {selectors.length > 0 && (
          <>
            <dt>Selectors</dt>
            <dd>
              {selectors.map((s: string) => (
                <div key={s} className="mono small">
                  {s}
                </div>
              ))}
            </dd>
          </>
        )}
        {drivers && (
          <>
            <dt>Config</dt>
            <dd>{drivers}</dd>
          </>
        )}
        {extended && (
          <>
            <dt>Extended resource name</dt>
            <dd className="mono">{extended}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** Allocated devices by key, from all claims; undefined while unknown (claims not listable). */
function useAllocations(resources: ResourceInfo[]) {
  const claims = useWatch(keyOf(resources, CLAIMS), null);
  return claims.loading || claims.error ? undefined : allocationMap(claims.items);
}

function DeviceRows({
  devices,
  driver,
  pool,
  allocations,
  onNavigate,
}: {
  devices: SliceDevice[];
  driver: string;
  pool: string;
  allocations?: Map<string, { name: string; namespace: string }>;
  onNavigate: Navigate;
}) {
  return (
    <>
      {devices.map((d) => {
        const holder = allocations?.get(deviceKey({ driver, pool, device: d.name }));
        return (
          <div key={`${driver}/${pool}/${d.name}`} className="container-card">
            <div className="row-between">
              <b className="mono">{d.name}</b>
              {holder ? (
                <span className="small">
                  allocated to{" "}
                  <Link onClick={() => onNavigate(CLAIMS, undefined, holder)}>
                    {holder.namespace}/{holder.name}
                  </Link>
                </span>
              ) : (
                allocations && <span className="muted small">free</span>
              )}
            </div>
            <div className="muted small">
              {driver} · pool {pool}
            </div>
            {(d.attributes.length > 0 || d.capacity.length > 0) && (
              <div className="chips">
                {d.capacity.map(([k, v]) => (
                  <span key={`c:${k}`} className="chip ok" title="capacity">
                    {k}: {v}
                  </span>
                ))}
                {d.attributes.map(([k, v]) => (
                  <span key={`a:${k}`} className="chip" title={`${k}=${v}`}>
                    {k}={v}
                  </span>
                ))}
              </div>
            )}
            {d.taints.map((t) => (
              <div key={t} className="small status warn">
                taint {t}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function ResourceSliceDetails({ obj, resources, onNavigate }: { obj: KubeObject; resources: ResourceInfo[]; onNavigate: Navigate }) {
  const allocations = useAllocations(resources);
  const devices = sliceDevices(obj);
  const pool = obj.spec?.pool ?? {};
  const node = obj.spec?.nodeName;
  return (
    <>
      <section className="meta">
        <h4>Slice</h4>
        <dl>
          <dt>Driver</dt>
          <dd className="mono">{obj.spec?.driver}</dd>
          <dt>Pool</dt>
          <dd>
            {pool.name} <span className="muted">· generation {pool.generation} · {pool.resourceSliceCount} slice(s)</span>
          </dd>
          <dt>Node</dt>
          <dd>{node ? <Link onClick={() => onNavigate("/nodes", undefined, { name: node })}>{node}</Link> : sliceNode(obj) || "—"}</dd>
        </dl>
      </section>
      <section>
        <h4>
          Devices ({devices.length}
          {allocations && `, ${devices.filter((d) => allocations.has(deviceKey({ driver: obj.spec?.driver, pool: pool.name, device: d.name }))).length} allocated`})
        </h4>
        <DeviceRows devices={devices} driver={obj.spec?.driver} pool={pool.name} allocations={allocations} onNavigate={onNavigate} />
      </section>
    </>
  );
}

/** Devices the node's resource slices advertise, and who holds them. */
export function NodeDevices({ node, resources, onNavigate }: { node: KubeObject; resources: ResourceInfo[]; onNavigate: Navigate }) {
  const slices = useWatch(keyOf(resources, SLICES), null);
  const allocations = useAllocations(resources);
  const mine = slices.items.filter((s) => s.spec?.nodeName === node.metadata.name);
  if (!mine.length) return null;
  return (
    <section>
      <h4>Devices</h4>
      {mine.map((s) => (
        <DeviceRows
          key={s.metadata.uid}
          devices={sliceDevices(s)}
          driver={s.spec?.driver}
          pool={s.spec?.pool?.name}
          allocations={allocations}
          onNavigate={onNavigate}
        />
      ))}
    </section>
  );
}

/** The pod's resource claims (direct or generated from templates), with their state. */
export function PodResourceClaims({ pod, resources, onNavigate }: { pod: KubeObject; resources: ResourceInfo[]; onNavigate: Navigate }) {
  const entries = podClaimNames(pod);
  const claims = useWatch(entries.length ? keyOf(resources, CLAIMS) : undefined, pod.metadata.namespace ?? null);
  if (!entries.length) return null;
  return (
    <section>
      <h4>Resource claims</h4>
      {entries.map((e) => {
        const claim = claims.items.find((c) => c.metadata.name === e.claim);
        const containers = containersUsingClaim(pod, e.entry);
        return (
          <div
            key={e.entry}
            className={`event-row ${claim ? "link" : ""}`}
            onClick={unlessSelecting(() => claim && onNavigate(CLAIMS, claim.metadata.uid))}
            title={e.template ? `From template ${e.template}` : "Direct"}
          >
            <span className="grow">
              <span className="mono small">{e.claim ?? e.entry}</span>
              <div className="muted small">
                {e.template ? `template ${e.template}` : "direct"}
                {containers.length > 0 && ` · used by ${containers.join(", ")}`}
              </div>
            </span>
            {claim ? (
              <span className={`status ${claim.status?.allocation ? "ok" : "warn"}`}>{claimState(claim)}</span>
            ) : (
              <span className="muted small">{e.claim ? "…" : "not created yet"}</span>
            )}
          </div>
        );
      })}
    </section>
  );
}
