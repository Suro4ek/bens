import { useEffect, useState } from "react";
import { api, ForwardInfo } from "../api";
import { useClusterId } from "../clusterContext";

/** Bumped whenever a forward starts or stops so the list refreshes. */
let listeners: (() => void)[] = [];
export const forwardsChanged = () => listeners.forEach((l) => l());

/** Running port forwards; with a cluster, only its own. */
export function useForwards(cluster?: string): ForwardInfo[] {
  const [list, setList] = useState<ForwardInfo[]>([]);
  useEffect(() => {
    const load = () => api.portForwardList().then(setList).catch(() => {});
    listeners.push(load);
    load();
    return () => {
      listeners = listeners.filter((l) => l !== load);
    };
  }, []);
  return cluster ? list.filter((f) => f.cluster === cluster) : list;
}

export const forwardUrl = (f: ForwardInfo) => `http://localhost:${f.localPort}`;

export function PortForwards() {
  const forwards = useForwards(useClusterId());
  return (
    <div className="overview">
      <h2>
        Port Forwarding <span className="count">{forwards.length}</span>
      </h2>
      <p className="muted">
        Start a forward from a pod's container ports or a service's ports in the details panel.
      </p>
      <div className="panel">
        {forwards.length === 0 && <div className="muted">No active port forwards.</div>}
        {forwards.map((f) => (
          <div key={f.id} className="event-row">
            <span className="chip">{f.kind}</span>
            <span className="grow mono">
              {f.namespace}/{f.name}:{f.remotePort}
            </span>
            <a
              href="#"
              className="mono"
              onClick={(e) => {
                e.preventDefault();
                api.openUrl(forwardUrl(f));
              }}
            >
              localhost:{f.localPort}
            </a>
            <button onClick={() => navigator.clipboard.writeText(forwardUrl(f))}>Copy</button>
            <button
              className="danger"
              onClick={() => api.portForwardStop(f.id).then(forwardsChanged)}
            >
              Stop
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
