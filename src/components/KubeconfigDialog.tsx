import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, Download } from "lucide-react";
import { api, KubeObject } from "../api";
import { copyText } from "../clipboard";
import { useApi } from "../clusterContext";
import { CodeEditor } from "./CodeEditor";

const DURATIONS: [number, string][] = [
  [1, "1 hour"],
  [24, "1 day"],
  [24 * 7, "7 days"],
  [24 * 30, "30 days"],
  [24 * 365, "1 year"],
];

/** Lens' service account "Kubeconfig": the cluster's server and CA with the account's token, to copy or save. */
export function KubeconfigDialog({
  account,
  onClose,
  notify,
}: {
  account: KubeObject;
  onClose: () => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}) {
  const capi = useApi();
  const { name, namespace = "default" } = account.metadata;
  const [hours, setHours] = useState(24 * 365);
  const [result, setResult] = useState<Awaited<ReturnType<typeof capi.serviceAccountKubeconfig>>>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
    capi.serviceAccountKubeconfig(namespace, name, hours).then(setResult, (e) => setError(String(e)));
  }, [capi, namespace, name, hours]);

  const download = async () => {
    if (!result) return;
    const path = await saveDialog({
      title: "Save kubeconfig",
      defaultPath: `service-account-${namespace}-${name}.yaml`,
      filters: [{ name: "Kubeconfig", extensions: ["yaml", "yml"] }],
    });
    if (!path) return;
    api.saveTextFile(path, result.kubeconfig).then(
      () => notify(`Saved ${path}`),
      (e) => notify(String(e), "bad"),
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal create-dialog" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>
          ServiceAccount <span className="mono">{namespace}/{name}</span> kubeconfig
        </h3>
        {error && <div className="banner bad">{error}</div>}
        {result?.tokenSource === "token-request" && (
          <div className="row-between small">
            <span className="muted">
              The account has no token Secret, so this uses a token that expires
              {result.expires ? ` on ${new Date(result.expires).toLocaleString()}` : ""}.
            </span>
            <label className="field inline">
              Valid for
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {DURATIONS.map(([h, label]) => (
                  <option key={h} value={h}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {result?.tokenSource === "secret" && <div className="muted small">Uses the account's token Secret (does not expire).</div>}
        <div className="modal-editor kubeconfig-editor">
          {result ? <CodeEditor value={result.kubeconfig} readOnly /> : !error && <div className="muted small chart-empty">Generating…</div>}
        </div>
        <div className="btn-row end">
          <button disabled={!result} onClick={() => result && copyText(result.kubeconfig, notify, "kubeconfig")}>
            <ClipboardCopy size={14} /> Copy to clipboard
          </button>
          <button disabled={!result} onClick={download}>
            <Download size={14} /> Download file
          </button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
