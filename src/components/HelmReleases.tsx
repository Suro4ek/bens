import { useCallback, useEffect, useMemo, useState } from "react";
import type { HelmDetails, HelmRelease } from "../api";
import { Status } from "../columns";
import { age } from "../util";
import { CodeEditor } from "./CodeEditor";
import { InstallChart } from "./InstallChart";
import { NamespaceSelect } from "./NamespaceSelect";
import { useApi } from "../clusterContext";
import { unlessSelecting } from "../clipboard";

const POLL_MS = 15_000;
const relKey = (r: HelmRelease) => `${r.namespace}/${r.name}`;
const helmTone = (s: string) => (s === "deployed" ? "Running" : /pending/.test(s) ? "Pending" : s === "failed" ? "Failed" : s);

interface Props {
  namespace: string | null;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}

export function HelmReleases({ namespace, notify }: Props) {
  const capi = useApi();
  const [releases, setReleases] = useState<HelmRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>();
  const [installing, setInstalling] = useState(false);

  const load = useCallback(
    () =>
      capi
        .helmList(namespace)
        .then((r) => {
          setReleases(r);
          setError(undefined);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false)),
    [namespace],
  );

  useEffect(() => {
    setLoading(true);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    return releases.filter((r) => !q || `${r.name} ${r.namespace} ${r.chart} ${r.status}`.toLowerCase().includes(q));
  }, [releases, filter]);
  const current = releases.find((r) => relKey(r) === selected);
  const template = "minmax(180px, 2fr) minmax(100px, 1fr) minmax(140px, 1.5fr) 110px 90px 100px 70px";

  return (
    <div className="content">
      <div className="table-wrap">
        <div className="table-toolbar">
          <NamespaceSelect />
          <input className="search" placeholder="Search releases…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="muted item-count">
            {rows.length} item{rows.length === 1 ? "" : "s"}
          </span>
          <div className="spacer" />
          <button className="primary" onClick={() => setInstalling(true)}>
            Install chart
          </button>
        </div>
        {installing && (
          <InstallChart
            namespace={namespace}
            onClose={() => setInstalling(false)}
            onInstalled={(msg) => {
              setInstalling(false);
              notify(msg);
              load();
            }}
          />
        )}
        {error && <div className="banner bad">{error}</div>}
        <div className="table">
          <div className="tr th" style={{ gridTemplateColumns: template }}>
            {["Name", "Namespace", "Chart", "App version", "Revision", "Status", "Updated"].map((h) => (
              <div key={h} className="td">
                {h}
              </div>
            ))}
          </div>
          <div className="tbody">
            {loading && <div className="empty">Loading…</div>}
            {!loading && rows.length === 0 && <div className="empty">No releases</div>}
            {rows.map((r) => (
              <div
                key={relKey(r)}
                className={`tr ${relKey(r) === selected ? "selected" : ""}`}
                style={{ gridTemplateColumns: template }}
                onClick={unlessSelecting(() => setSelected(relKey(r)))}
              >
                <div className="td">{r.name}</div>
                <div className="td">{r.namespace}</div>
                <div className="td">
                  {r.chart}-{r.chartVersion}
                </div>
                <div className="td">{r.appVersion}</div>
                <div className="td">{r.revision}</div>
                <div className="td">
                  <Status text={helmTone(r.status)} />
                </div>
                <div className="td">{age(r.updated)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {current && (
        <ReleaseDetails
          key={relKey(current) + current.revision}
          release={current}
          onClose={() => setSelected(undefined)}
          onChanged={load}
          notify={notify}
        />
      )}
    </div>
  );
}

type Tab = "values" | "defaults" | "manifest" | "notes" | "history";

function ReleaseDetails({
  release,
  onClose,
  onChanged,
  notify,
}: {
  release: HelmRelease;
  onClose: () => void;
  onChanged: () => void;
  notify: Props["notify"];
}) {
  const capi = useApi();
  const [details, setDetails] = useState<HelmDetails>();
  const [tab, setTab] = useState<Tab>("values");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    capi
      .helmGet(release.namespace, release.name)
      .then(setDetails)
      .catch((e) => notify(String(e), "bad"));
  }, [release.namespace, release.name, release.revision, notify]);

  const run = async (label: string, f: () => Promise<string>) => {
    setBusy(true);
    try {
      const out = await f();
      notify(out || label);
      onChanged();
    } catch (e) {
      notify(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const text: Record<Exclude<Tab, "history">, string> = {
    values: details?.values || "# no user-supplied values",
    defaults: details?.defaultValues ?? "",
    manifest: details?.manifest ?? "",
    notes: details?.notes || "# no notes",
  };

  return (
    <aside className="details wide">
      <header>
        <div>
          <div className="muted small">Helm release · {release.namespace}</div>
          <h3>{release.name}</h3>
        </div>
        <button className="icon" onClick={onClose}>
          ✕
        </button>
      </header>
      <dl>
        <dt>Chart</dt>
        <dd>
          {release.chart}-{release.chartVersion} <span className="muted">(app {release.appVersion || "—"})</span>
        </dd>
        <dt>Status</dt>
        <dd>
          <Status text={helmTone(release.status)} /> <span className="muted small">{release.description}</span>
        </dd>
        <dt>Revision</dt>
        <dd>
          {release.revision} · {age(release.updated)} ago
        </dd>
      </dl>
      <div className="btn-row">
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            confirm(`Uninstall release ${release.name} from ${release.namespace}? This deletes its resources.`) &&
            run("Uninstalled", () => capi.helmUninstall(release.namespace, release.name)).then(onClose)
          }
        >
          Uninstall
        </button>
      </div>
      <div className="seg small-seg">
        {(["values", "defaults", "manifest", "notes", "history"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "defaults" ? "chart values" : t}
          </button>
        ))}
      </div>
      {!details && <div className="muted">Loading…</div>}
      {details && tab !== "history" && (
        <div className="details-editor">
          <CodeEditor value={text[tab]} readOnly />
        </div>
      )}
      {details && tab === "history" && (
        <div>
          {details.history.map((h) => (
            <div key={h.revision} className="event-row">
              <b>#{h.revision}</b>
              <Status text={helmTone(h.status)} />
              <span className="grow small">
                {h.chart}-{h.chartVersion} · {h.description}
              </span>
              <span className="muted small">{age(h.updated)}</span>
              {h.revision !== release.revision && (
                <button
                  disabled={busy}
                  onClick={() =>
                    confirm(`Roll back ${release.name} to revision ${h.revision}?`) &&
                    run(`Rolled back to #${h.revision}`, () => capi.helmRollback(release.namespace, release.name, h.revision))
                  }
                >
                  Rollback
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
