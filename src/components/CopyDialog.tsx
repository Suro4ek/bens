import { useEffect, useState } from "react";
import { clusterApi, Connection, KubeObject, ResourceInfo } from "../api";
import { ClusterContext } from "../clusterContext";
import { copyObjects, copyProblem, CopyResult } from "../copy";
import { navId } from "../nav";
import { useWatch } from "../useWatch";

export interface ClusterChoice {
  id: string;
  label: string;
  conn: Connection;
}

/** Namespaces of the target cluster, for the namespace field's suggestions. */
function TargetNamespaces({ conn, onNames }: { conn: Connection; onNames: (names: string[]) => void }) {
  const key = conn.resources.find((r) => navId(r) === "/namespaces")?.key;
  const { items } = useWatch(key, null);
  useEffect(() => onNames(items.map((n) => n.metadata.name).sort()), [items, onNames]);
  return null;
}

const OUTCOME_TEXT: Record<CopyResult["outcome"], string> = {
  created: "created",
  replaced: "replaced",
  exists: "already exists — not changed",
  skipped: "skipped",
  failed: "failed",
};

/** Copies Secrets or ConfigMaps to another connected cluster, or another namespace. */
export function CopyDialog({
  resource,
  objects,
  sourceCluster,
  clusters,
  onClose,
  notify,
}: {
  resource: ResourceInfo;
  objects: KubeObject[];
  sourceCluster: string;
  /** Connected clusters (the source included: copying to another namespace is fine). */
  clusters: ClusterChoice[];
  onClose: () => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}) {
  const single = objects.length === 1 ? objects[0] : undefined;
  const sourceNs = [...new Set(objects.map((o) => o.metadata.namespace ?? ""))];
  const [target, setTarget] = useState(() => clusters.find((c) => c.id !== sourceCluster)?.id ?? sourceCluster);
  const [namespace, setNamespace] = useState(sourceNs.length === 1 ? sourceNs[0] : "default");
  const [name, setName] = useState(single?.metadata.name ?? "");
  const [overwrite, setOverwrite] = useState(false);
  const [createNamespace, setCreateNamespace] = useState(true);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CopyResult[] | null>(null);

  const targetConn = clusters.find((c) => c.id === target)?.conn;
  const targetKey = targetConn?.resources.find((r) => navId(r) === navId(resource))?.key;
  const skipped = objects.filter((o) => copyProblem(o));
  const sameObject =
    target === sourceCluster && objects.some((o) => o.metadata.namespace === namespace && (single ? name : o.metadata.name) === o.metadata.name);
  const problem = !targetKey
    ? `${resource.kind}s are not available in that cluster`
    : !namespace
      ? "Choose a namespace"
      : single && !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)
        ? "Name: lowercase letters, digits, \"-\" and \".\""
        : sameObject
          ? "That is where it already is: pick another cluster, namespace or name"
          : skipped.length === objects.length
            ? "Nothing to copy"
            : undefined;

  const copy = async () => {
    if (!targetConn || !targetKey || problem) return;
    setBusy(true);
    const res = await copyObjects({
      target: clusterApi(target),
      key: targetKey,
      namespacesKey: targetConn.resources.find((r) => navId(r) === "/namespaces")?.key,
      namespace,
      objects,
      rename: single ? name : undefined,
      overwrite,
      createNamespace,
    });
    setBusy(false);
    const done = res.filter((r) => r.outcome === "created" || r.outcome === "replaced").length;
    const where = `${clusters.find((c) => c.id === target)?.label}/${namespace}`;
    if (res.every((r) => r.outcome === "created" || r.outcome === "replaced")) {
      notify(`Copied ${done} ${resource.kind}${done === 1 ? "" : "s"} to ${where}`);
      onClose();
    } else {
      setResults(res);
      if (done) notify(`Copied ${done} of ${res.length} to ${where}`, "bad");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal create-dialog"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          copy();
        }}
      >
        <h3>
          Copy {single ? `${resource.kind} ${single.metadata.name}` : `${objects.length} ${resource.kind}s`}
        </h3>
        {targetConn && (
          <ClusterContext.Provider value={target}>
            <TargetNamespaces key={target} conn={targetConn} onNames={setNamespaces} />
          </ClusterContext.Provider>
        )}
        <div className="create-grid">
          <label className="field">
            To cluster
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.id === sourceCluster ? " (this cluster)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Namespace
            <input className="mono" list="copy-namespaces" value={namespace} onChange={(e) => setNamespace(e.target.value.trim())} />
            <datalist id="copy-namespaces">
              {namespaces.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          {single && (
            <label className="field">
              Name
              <input className="mono" value={name} onChange={(e) => setName(e.target.value.trim())} />
            </label>
          )}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite if it already exists there</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={createNamespace} onChange={(e) => setCreateNamespace(e.target.checked)} />
          <span>Create the namespace if it doesn't exist</span>
        </label>
        {clusters.length === 1 && (
          <div className="muted small">Connect another cluster to copy there; meanwhile you can copy to another namespace.</div>
        )}
        {!single && (
          <div className="copy-list">
            {objects.map((o) => (
              <div key={o.metadata.uid ?? o.metadata.name} className="small">
                <span className="mono">
                  {o.metadata.namespace}/{o.metadata.name}
                </span>
                {copyProblem(o) && <span className="muted"> — skipped: {copyProblem(o)}</span>}
              </div>
            ))}
          </div>
        )}
        {single && copyProblem(single) && <div className="small status warn">Not copied: {copyProblem(single)}</div>}
        {results && (
          <div className="copy-list">
            {results.map((r) => (
              <div key={r.name} className="small">
                <span className="mono">{r.name}</span>{" "}
                <span className={`status ${r.outcome === "created" || r.outcome === "replaced" ? "ok" : r.outcome === "failed" ? "bad" : "warn"}`}>
                  {OUTCOME_TEXT[r.outcome]}
                </span>
                {r.message && r.outcome !== "exists" && <span className="muted"> — {r.message}</span>}
              </div>
            ))}
            {results.some((r) => r.outcome === "exists") && (
              <div className="muted small">Tick “Overwrite” to replace the existing ones.</div>
            )}
          </div>
        )}
        {problem && <div className="small status bad">{problem}</div>}
        <div className="btn-row end">
          <button type="button" onClick={onClose}>
            {results ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="primary" disabled={busy || !!problem}>
            {busy ? "Copying…" : "Copy"}
          </button>
        </div>
      </form>
    </div>
  );
}
