import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Contexts, ContextInfo } from "../api";
import { clusterName, usePrefs } from "../prefs";
import { ClusterIcon } from "./ClusterIcon";
import { ask } from "./Confirm";

interface Props {
  catalog: Contexts;
  connecting: string[];
  /** Connected context. */
  connected: string[];
  error?: string;
  onPick: (ctx: ContextInfo) => void;
  onSettings: (ctx: ContextInfo) => void;
  onChanged: () => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}

const SOURCE_LABEL = { sync: "synced", env: "$KUBECONFIG", pasted: "added in Bens" } as const;

export function Catalog({ catalog, connecting, connected, error, onPick, onSettings, onChanged, notify }: Props) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const { clusters } = usePrefs();

  const removeSource = async (path: string, what: string) => {
    if (!(await ask({ title: `Remove ${what}?`, message: "Its clusters disappear from the catalog. The file itself is kept.", ok: "Remove", danger: true })))
      return;
    try {
      await api.removeKubeconfigSource(path);
      onChanged();
    } catch (e) {
      notify(String(e), "bad");
    }
  };

  // Group contexts by kubeconfig file so it is clear where each cluster comes from.
  const byFile = new Map<string, ContextInfo[]>();
  const q = filter.trim().toLowerCase();
  const visible = catalog.contexts.filter(
    (c) => !q || `${clusterName(c, clusters[c.id])} ${c.name} ${c.server ?? ""} ${c.user}`.toLowerCase().includes(q),
  );
  for (const c of visible) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);

  return (
    <div className="catalog">
      <div className="row-between">
        <div>
          <h1>Clusters</h1>
          <p className="muted">Contexts from your kubeconfig files. Click a cluster to connect.</p>
        </div>
        <div className="btn-row">
          <input className="search" placeholder="Filter clusters…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={onChanged} title="Re-read kubeconfig files">
            ↻
          </button>
          <button className="primary" onClick={() => setAdding(true)}>
            + Add cluster
          </button>
        </div>
      </div>
      {error && <div className="banner bad">{error}</div>}

      {[...byFile.entries()].map(([file, ctxs]) => (
        <section key={file} className="file-group">
          <div className="file-head mono small muted">
            {file}
            {ctxs[0].pasted && (
              <button className="icon" title="Remove this kubeconfig" onClick={() => removeSource(file, "this kubeconfig")}>
                ✕
              </button>
            )}
          </div>
          <div className="cards">
            {ctxs.map((c) => {
              const p = clusters[c.id];
              const name = clusterName(c, p);
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  className={`card ${connecting.includes(c.id) ? "disabled" : ""}`}
                  onClick={() => !connecting.includes(c.id) && onPick(c)}
                  onKeyDown={(e) => e.key === "Enter" && !connecting.includes(c.id) && onPick(c)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSettings(c);
                  }}
                >
                  <ClusterIcon ctx={c} prefs={p} />
                  <div className="card-body">
                    <div className="card-title">
                      {name}
                      {name !== c.name && <span className="muted small">{c.name}</span>}
                      {c.name === catalog.current && file.endsWith("/.kube/config") && <span className="chip">current</span>}
                    </div>
                    <div className="muted small mono">{c.server ?? c.cluster}</div>
                    <div className="muted small">
                      user: {c.user}
                      {c.namespace ? ` · ns: ${c.namespace}` : ""}
                    </div>
                  </div>
                  {connecting.includes(c.id) && <div className="spinner" />}
                  {connected.includes(c.id) && <span className="chip ok">connected</span>}
                  <button
                    className="icon card-gear"
                    title="Cluster settings"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSettings(c);
                    }}
                  >
                    ⚙
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {catalog.contexts.length > 0 && visible.length === 0 && <div className="empty">No clusters match “{filter}”.</div>}
      {catalog.contexts.length === 0 && (
        <div className="empty">
          No clusters yet. Use <b>+ Add cluster</b> to paste a kubeconfig or pick a file.
        </div>
      )}

      <section className="sources">
        <h3>Kubeconfig sources</h3>
        {catalog.sources.map((s) => (
          <div key={s.path + s.kind} className="source-row">
            <span className="mono">{s.path}</span>
            <span className="chip">{SOURCE_LABEL[s.kind]}</span>
            <span className="muted small">
              {s.exists ? `${s.contexts} context${s.contexts === 1 ? "" : "s"}` : "missing"}
            </span>
            {s.errors.map((e) => (
              <span key={e} className="status bad small">
                {e}
              </span>
            ))}
            <div className="spacer" />
            {s.kind === "sync" && (
              <button className="icon" title="Stop syncing" onClick={() => removeSource(s.path, `sync of ${s.path}`)}>
                ✕
              </button>
            )}
          </div>
        ))}
      </section>

      {adding && (
        <AddClusterDialog
          onClose={() => setAdding(false)}
          onAdded={(msg) => {
            setAdding(false);
            notify(msg);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function AddClusterDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (msg: string) => void }) {
  const [mode, setMode] = useState<"paste" | "path">("paste");
  const [yaml, setYaml] = useState("");
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const pick = async (directory: boolean) => {
    const p = await open({ directory, multiple: false, title: directory ? "Folder with kubeconfigs" : "Kubeconfig file" });
    if (typeof p === "string") setPath(p);
  };

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      if (mode === "paste") {
        const n = await api.addKubeconfigText(yaml);
        onAdded(`Added ${n} context${n === 1 ? "" : "s"}`);
      } else {
        await api.addKubeconfigPath(path);
        onAdded(`Syncing ${path}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h3>Add cluster</h3>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="seg">
          <button className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>
            Paste kubeconfig
          </button>
          <button className={mode === "path" ? "on" : ""} onClick={() => setMode("path")}>
            Sync file or folder
          </button>
        </div>

        {mode === "paste" ? (
          <>
            <p className="muted small">
              The kubeconfig is saved into Bens' data folder (readable only by you). All its contexts appear in the catalog.
            </p>
            <textarea
              className="yaml-editor modal-editor"
              spellCheck={false}
              placeholder={"apiVersion: v1\nkind: Config\nclusters: …\ncontexts: …\nusers: …"}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              autoFocus
            />
          </>
        ) : (
          <>
            <p className="muted small">
              Bens reads the file in place, or every kubeconfig directly inside the folder, on each catalog refresh.
            </p>
            <div className="btn-row">
              <input className="grow mono" placeholder="~/path/to/kubeconfig" value={path} onChange={(e) => setPath(e.target.value)} />
              <button onClick={() => pick(false)}>File…</button>
              <button onClick={() => pick(true)}>Folder…</button>
            </div>
          </>
        )}

        {err && <div className="banner bad">{err}</div>}
        <div className="btn-row end">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || (mode === "paste" ? !yaml.trim() : !path.trim())}
            onClick={submit}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
