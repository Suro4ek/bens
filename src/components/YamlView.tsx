import { useEffect, useState } from "react";
import { api, KubeObject, ResourceInfo } from "../api";
import { CodeEditor } from "./CodeEditor";

type Msg = { tone: "ok" | "bad"; text: string } | null;

function Toolbar({ children, msg }: { children: React.ReactNode; msg: Msg }) {
  return (
    <div className="dock-toolbar">
      {children}
      {msg && <span className={`status ${msg.tone} ellipsis`}>{msg.text}</span>}
    </div>
  );
}

/** Edit an existing object (replace). */
export function YamlView({ resource, obj }: { resource: ResourceInfo; obj: KubeObject }) {
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const { namespace, name } = obj.metadata;

  const load = () => {
    setMsg(null);
    api
      .getYaml(resource.key, namespace, name)
      .then((y) => {
        setText(y);
        setOriginal(y);
      })
      .catch((e) => setMsg({ tone: "bad", text: String(e) }));
  };
  useEffect(load, [resource.key, namespace, name]);

  const dirty = text !== original;
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const y = await api.applyYaml(resource.key, namespace, name, text);
      setText(y);
      setOriginal(y);
      setMsg({ tone: "ok", text: "Saved" });
    } catch (e) {
      setMsg({ tone: "bad", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="yaml">
      <Toolbar msg={msg}>
        <button className="primary" disabled={!dirty || busy} onClick={save}>
          Save <kbd>⌘S</kbd>
        </button>
        <button disabled={busy} onClick={load}>
          Reload
        </button>
        <button disabled={!dirty} onClick={() => setText(original)}>
          Revert
        </button>
        {dirty && <span className="muted small">modified</span>}
      </Toolbar>
      <CodeEditor value={text} onChange={setText} onSave={save} />
    </div>
  );
}

const TEMPLATE = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  key: value
`;

/** Create or update objects from YAML (server-side apply; multiple documents allowed). */
export function CreateView({ namespace }: { namespace: string | null }) {
  const [text, setText] = useState(TEMPLATE);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const done = await api.applyManifest(text, namespace);
      setMsg({ tone: "ok", text: `Applied: ${done.join(", ")}` });
    } catch (e) {
      setMsg({ tone: "bad", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="yaml">
      <Toolbar msg={msg}>
        <button className="primary" disabled={busy || !text.trim()} onClick={apply}>
          Apply <kbd>⌘S</kbd>
        </button>
        <span className="muted small">
          server-side apply · default namespace: {namespace ?? "default"} · separate objects with ---
        </span>
      </Toolbar>
      <CodeEditor value={text} onChange={setText} onSave={apply} />
    </div>
  );
}
