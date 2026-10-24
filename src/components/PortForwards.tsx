import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api, clusterApi, ForwardInfo } from "../api";
import { copyText } from "../clipboard";
import { useClusterId } from "../clusterContext";
import { storage } from "../util";

type Notify = (msg: string, tone?: "ok" | "bad") => void;

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

export const forwardUrl = (f: ForwardInfo) => `${f.protocol ?? "http"}://localhost:${f.localPort}`;

/** Like Lens: a port named "https…" (or 443 / 8443) is opened over https. */
export const predictProtocol = (portName?: string, port?: number): "http" | "https" =>
  /https/i.test(portName ?? "") || port === 443 || port === 8443 ? "https" : "http";

const OPEN_KEY = "portForwardOpenInBrowser";

/** What a forward goes to. */
export interface ForwardTarget {
  cluster: string;
  kind: "pod" | "service";
  namespace: string;
  name: string;
  port: number;
  portName?: string;
}

/**
 * Lens' "Port Forwarding for …" dialog: the local port (empty for a random one), https, and
 * whether to open it in the browser. With an existing forward it modifies it (restarts it on
 * the new port or protocol).
 */
export function PortForwardDialog({
  target,
  existing,
  onClose,
  notify,
}: {
  target: ForwardTarget;
  existing?: ForwardInfo;
  onClose: () => void;
  notify: Notify;
}) {
  const [localPort, setLocalPort] = useState(existing ? String(existing.localPort) : "");
  const [https, setHttps] = useState((existing?.protocol ?? predictProtocol(target.portName, target.port)) === "https");
  const [openInBrowser, setOpenInBrowser] = useState(storage.get(OPEN_KEY) !== "0");
  const [busy, setBusy] = useState(false);
  const port = localPort ? Number(localPort) : undefined;
  const invalid = port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535);

  const submit = async () => {
    if (invalid) return;
    storage.set(OPEN_KEY, openInBrowser ? "1" : "0");
    const protocol = https ? "https" : "http";
    setBusy(true);
    try {
      let f = existing;
      if (!existing || (port !== undefined && port !== existing.localPort) || protocol !== existing.protocol) {
        if (existing) await api.portForwardStop(existing.id);
        f = await clusterApi(target.cluster).portForwardStart(target.kind, target.namespace, target.name, target.port, port, protocol);
        notify(`Forwarding ${forwardUrl(f)} → ${target.name}:${target.port}`);
      }
      forwardsChanged();
      if (openInBrowser && f) api.openUrl(forwardUrl(f));
      onClose();
    } catch (e) {
      notify(String(e), "bad");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal pf-dialog"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>
          Port Forwarding for <span className="mono">{target.name}</span>
        </h3>
        <p className="muted small">
          {target.kind} {target.namespace}/{target.name}, port {target.port}
          {target.portName ? ` (${target.portName})` : ""}
        </p>
        <label className="field inline">
          Local port to forward from:
          <input
            autoFocus
            className="mono"
            type="number"
            min={1}
            max={65535}
            placeholder="Random"
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
          />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />
          <span>https</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={openInBrowser} onChange={(e) => setOpenInBrowser(e.target.checked)} />
          <span>Open in Browser</span>
        </label>
        {invalid && <div className="small status bad">The port must be between 1 and 65535</div>}
        <div className="btn-row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || invalid}>
            {existing ? "Modify" : "Start"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A running forward: its address (click to open in the browser), and Edit / Stop. */
export function ForwardControls({ forward, onEdit, notify }: { forward: ForwardInfo; onEdit: () => void; notify: Notify }) {
  return (
    <>
      <a
        href="#"
        className="mono pf-link"
        title="Open in a browser"
        onClick={(e) => {
          e.preventDefault();
          api.openUrl(forwardUrl(forward));
        }}
      >
        {forward.protocol === "https" ? "https://" : ""}localhost:{forward.localPort}
        <ExternalLink size={12} />
      </a>
      <button type="button" onClick={onEdit}>
        Edit
      </button>
      <button
        type="button"
        onClick={() =>
          api.portForwardStop(forward.id).then(() => {
            forwardsChanged();
            notify(`Stopped forwarding localhost:${forward.localPort}`);
          })
        }
      >
        Stop
      </button>
    </>
  );
}

export function PortForwards({ notify }: { notify: Notify }) {
  const forwards = useForwards(useClusterId());
  const [editing, setEditing] = useState<ForwardInfo | null>(null);
  return (
    <div className="overview">
      <h2>
        Port Forwarding <span className="count">{forwards.length}</span>
      </h2>
      <p className="muted">Start a forward from a pod's container ports or a service's ports in the details panel.</p>
      <div className="panel">
        {forwards.length === 0 && <div className="muted">No active port forwards.</div>}
        {forwards.map((f) => (
          <div key={f.id} className="event-row">
            <span className="chip">{f.kind}</span>
            <span className="grow mono">
              {f.namespace}/{f.name}:{f.remotePort}
            </span>
            <button type="button" onClick={() => copyText(forwardUrl(f), notify, forwardUrl(f))}>
              Copy
            </button>
            <ForwardControls forward={f} onEdit={() => setEditing(f)} notify={notify} />
          </div>
        ))}
      </div>
      {editing && (
        <PortForwardDialog
          target={{ cluster: editing.cluster, kind: editing.kind, namespace: editing.namespace, name: editing.name, port: editing.remotePort }}
          existing={editing}
          onClose={() => setEditing(null)}
          notify={notify}
        />
      )}
    </div>
  );
}
