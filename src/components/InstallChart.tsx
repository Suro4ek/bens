import { useEffect, useState } from "react";
import { api, ChartHit, HelmRepo } from "../api";
import { CodeEditor } from "./CodeEditor";

interface Props {
  namespace: string | null;
  onClose: () => void;
  onInstalled: (msg: string) => void;
}

/** Search charts in the user's helm repos and install one (helm CLI). */
export function InstallChart({ namespace, onClose, onInstalled }: Props) {
  const [repos, setRepos] = useState<HelmRepo[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChartHit[]>([]);
  const [chart, setChart] = useState<ChartHit>();
  const [versions, setVersions] = useState<ChartHit[]>([]);
  const [version, setVersion] = useState("");
  const [values, setValues] = useState("");
  const [name, setName] = useState("");
  const [ns, setNs] = useState(namespace ?? "default");
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();

  const guard = async <T,>(label: string, f: () => Promise<T>) => {
    setBusy(label);
    setErr(undefined);
    try {
      return await f();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const loadRepos = () => guard("repos", () => api.helmRepoList().then(setRepos));
  useEffect(() => {
    loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search across all added repos.
  useEffect(() => {
    if (chart) return;
    const t = setTimeout(() => {
      api
        .helmSearch(query.trim())
        .then(setHits)
        .catch((e) => setErr(String(e)));
    }, 300);
    return () => clearTimeout(t);
  }, [query, chart, repos]);

  const pick = (hit: ChartHit) => {
    setChart(hit);
    setName(hit.name.split("/")[1] ?? hit.name);
    guard("versions", async () => {
      const vs = await api.helmSearch(hit.name, true);
      setVersions(vs);
      setVersion(hit.version);
    });
  };

  useEffect(() => {
    if (!chart || !version) return;
    guard("values", () => api.helmShowValues(chart.name, version).then(setValues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, version]);

  const install = () =>
    guard("install", async () => {
      await api.helmInstall(name, ns, chart!.name, version, values);
      onInstalled(`Installed ${name} (${chart!.name} ${version}) into ${ns}`);
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal install" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h3>{chart ? `Install ${chart.name}` : "Install Helm chart"}</h3>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </div>

        {!chart ? (
          <>
            <div className="small muted">
              Repositories:{" "}
              {repos.length ? repos.map((r) => <span key={r.name} className="chip" title={r.url}>{r.name}</span>) : "none"}{" "}
              <button className="icon" disabled={!!busy} onClick={() => guard("update", () => api.helmRepoUpdate().then(loadRepos))}>
                {busy === "update" ? "updating…" : "↻ update"}
              </button>
            </div>
            <div className="btn-row">
              <input placeholder="repo name" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
              <input className="grow" placeholder="https://charts.example.com" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
              <button
                disabled={!repoName || !repoUrl || !!busy}
                onClick={() =>
                  guard("add", async () => {
                    await api.helmRepoAdd(repoName, repoUrl);
                    setRepoName("");
                    setRepoUrl("");
                    await loadRepos();
                  })
                }
              >
                Add repo
              </button>
            </div>
            <input autoFocus placeholder="Search charts…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="chart-hits">
              {hits.map((h) => (
                <div key={h.name} className="event-row link" onClick={() => pick(h)}>
                  <b className="mono small">{h.name}</b>
                  <span className="chip">{h.version}</span>
                  <span className="grow small muted">{h.description}</span>
                </div>
              ))}
              {hits.length === 0 && <div className="muted small">No charts found{repos.length ? "" : " — add a repository first"}.</div>}
            </div>
          </>
        ) : (
          <>
            <div className="btn-row">
              <label className="field">
                Release name
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                Namespace
                <input value={ns} onChange={(e) => setNs(e.target.value)} />
              </label>
              <label className="field">
                Version
                <select value={version} onChange={(e) => setVersion(e.target.value)}>
                  {(versions.length ? versions : [chart]).map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version} {v.app_version ? `(app ${v.app_version})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="install-editor">
              <CodeEditor value={values} onChange={setValues} />
            </div>
          </>
        )}

        {err && <div className="banner bad">{err}</div>}
        <div className="btn-row end">
          {chart && (
            <button onClick={() => setChart(undefined)} disabled={!!busy}>
              Back
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          {chart && (
            <button className="primary" disabled={!!busy || !name || !ns || !version} onClick={install}>
              {busy === "install" ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
