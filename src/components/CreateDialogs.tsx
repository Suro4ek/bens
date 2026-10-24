import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ClipboardPaste, FileUp, Plus, X } from "lucide-react";
import { api, ResourceInfo } from "../api";
import { useApi } from "../clusterContext";

type Notify = (msg: string, tone?: "ok" | "bad") => void;

interface Row {
  id: number;
  key: string;
  value: string;
  /** Loaded from a file: base64 content and the file's name (the value field shows the name). */
  file?: { name: string; b64: string };
  /** Required by the type (key can't be changed or removed). */
  fixed?: boolean;
  placeholder?: string;
  multiline?: boolean;
}

let rowSeq = 0;
const row = (key = "", extra: Partial<Row> = {}): Row => ({ id: ++rowSeq, key, value: "", ...extra });

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const DATA_KEY = /^[-._a-zA-Z0-9]+$/;

const utf8ToB64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};
/** Decodes base64 as UTF-8 text; undefined when it is binary. */
const b64ToText = (b64: string) => {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** `KEY=value` lines (a .env file): comments, `export` and surrounding quotes are dropped. */
export function parseEnv(text: string): [string, string][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^export\s+/, ""))
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      let v = l.slice(i + 1).trim();
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      return [l.slice(0, i).trim(), v] as [string, string];
    });
}

/** Rows of keys and values with add / remove, a value from a file, and pasting .env lines. */
function KeyValues({
  title,
  rows,
  onChange,
  files,
  envPaste,
}: {
  title: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  files?: boolean;
  envPaste?: boolean;
}) {
  const [pasting, setPasting] = useState<string | null>(null);
  const update = (id: number, patch: Partial<Row>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const loadFile = async (r: Row) => {
    const path = await openDialog({ multiple: false, title: `Value of ${r.key || "the key"}` });
    if (typeof path !== "string") return;
    try {
      const b64 = await api.readFileBase64(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      update(r.id, { file: { name, b64 }, key: r.key || name });
    } catch (e) {
      alert(String(e));
    }
  };
  const addPasted = () => {
    const pairs = parseEnv(pasting ?? "");
    // Pasted keys replace empty rows and rows with the same key.
    const keys = new Set(pairs.map(([k]) => k));
    const kept = rows.filter((r) => r.fixed || ((r.key || r.value || r.file) && !keys.has(r.key)));
    onChange([...kept, ...pairs.map(([k, v]) => ({ ...row(k), value: v }))]);
    setPasting(null);
  };

  return (
    <div className="kv">
      <div className="kv-head">
        <span>{title}</span>
        <button type="button" className="icon" title={`Add ${title.toLowerCase()} entry`} onClick={() => onChange([...rows, row()])}>
          <Plus size={14} />
        </button>
        {envPaste && (
          <button type="button" className="icon" title="Paste KEY=value lines (.env)" onClick={() => setPasting(pasting === null ? "" : null)}>
            <ClipboardPaste size={14} />
          </button>
        )}
      </div>
      {pasting !== null && (
        <div className="kv-paste">
          <textarea
            autoFocus
            className="mono"
            rows={5}
            placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…"}
            value={pasting}
            onChange={(e) => setPasting(e.target.value)}
          />
          <div className="btn-row">
            <button type="button" className="primary" disabled={!parseEnv(pasting).length} onClick={addPasted}>
              Add {parseEnv(pasting).length || ""} entries
            </button>
            <button type="button" onClick={() => setPasting(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {rows.map((r) => (
        <div key={r.id} className="kv-row">
          <input
            className="mono"
            placeholder="Key"
            value={r.key}
            readOnly={r.fixed}
            tabIndex={r.fixed ? -1 : 0}
            onChange={(e) => update(r.id, { key: e.target.value })}
          />
          {r.file ? (
            <div className="kv-file" title={`${r.file.name} — loaded from file`}>
              <FileUp size={13} />
              <span className="ellipsis">{r.file.name}</span>
              <span className="muted small">{Math.round((r.file.b64.length * 3) / 4)} bytes</span>
              <button type="button" className="icon" title="Clear" onClick={() => update(r.id, { file: undefined })}>
                <X size={13} />
              </button>
            </div>
          ) : (
            <textarea
              className="mono"
              rows={r.multiline || r.value.includes("\n") ? 4 : 1}
              placeholder={r.placeholder ?? "Value"}
              value={r.value}
              onChange={(e) => update(r.id, { value: e.target.value })}
            />
          )}
          {files && !r.file ? (
            <button type="button" className="icon" title="Load the value from a file" onClick={() => loadFile(r)}>
              <FileUp size={14} />
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="icon"
            disabled={r.fixed}
            title={r.fixed ? "Required by the type" : "Remove"}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Problems that stop creating: bad or duplicate keys. */
function keyProblems(rows: Row[], what: string, strict: boolean): string[] {
  const used = rows.filter((r) => r.key || r.value || r.file);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of used) {
    if (!r.key) problems.push(`${what}: a value has no key`);
    else if (strict && !DATA_KEY.test(r.key)) problems.push(`${what}: "${r.key}" may only contain letters, digits, "-", "_" and "."`);
    else if (seen.has(r.key)) problems.push(`${what}: "${r.key}" is used twice`);
    seen.add(r.key);
  }
  return problems;
}
const toMap = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.key).map((r) => [r.key, r.value]));

interface DialogProps {
  resource: ResourceInfo;
  /** Namespace the list is filtered to; the default for the new object. */
  namespace: string | null;
  namespaces: string[];
  onClose: () => void;
  onCreated: (namespace: string, name: string) => void;
  notify: Notify;
}

function Shell({
  title,
  children,
  problems,
  busy,
  onClose,
  onCreate,
}: {
  title: string;
  children: React.ReactNode;
  problems: string[];
  busy: boolean;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal create-dialog"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!problems.length) onCreate();
        }}
      >
        <h3>{title}</h3>
        <div className="create-body">{children}</div>
        {problems.length > 0 && <div className="small status bad">{problems[0]}</div>}
        <div className="btn-row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || problems.length > 0}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function NameAndNamespace({
  kind,
  name,
  setName,
  namespace,
  setNamespace,
  namespaces,
  extra,
}: {
  kind: string;
  name: string;
  setName: (v: string) => void;
  namespace: string;
  setNamespace: (v: string) => void;
  namespaces: string[];
  extra?: React.ReactNode;
}) {
  return (
    <div className="create-grid">
      <label className="field">
        {kind} name *
        <input autoFocus required className="mono" placeholder="my-config" value={name} onChange={(e) => setName(e.target.value.trim())} />
      </label>
      <label className="field">
        Namespace
        <input className="mono" list="create-namespaces" value={namespace} onChange={(e) => setNamespace(e.target.value.trim())} />
        <datalist id="create-namespaces">
          {namespaces.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
      {extra}
    </div>
  );
}

function useCreate(resource: ResourceInfo, { onClose, onCreated, notify }: Pick<DialogProps, "onClose" | "onCreated" | "notify">) {
  const capi = useApi();
  const [busy, setBusy] = useState(false);
  const create = async (namespace: string, name: string, object: Record<string, unknown>) => {
    setBusy(true);
    try {
      await capi.create(resource.key, namespace, object);
      notify(`Created ${resource.kind} ${namespace}/${name}`);
      onClose();
      onCreated(namespace, name);
    } catch (e) {
      notify(String(e), "bad");
      setBusy(false);
    }
  };
  return { busy, create };
}

const meta = (name: string, namespace: string, labels: Row[], annotations: Row[]) => ({
  name,
  namespace,
  ...(labels.some((r) => r.key) ? { labels: toMap(labels) } : {}),
  ...(annotations.some((r) => r.key) ? { annotations: toMap(annotations) } : {}),
});

export function CreateConfigMapDialog(props: DialogProps) {
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState(props.namespace ?? "default");
  const [data, setData] = useState<Row[]>([row()]);
  const [labels, setLabels] = useState<Row[]>([]);
  const [annotations, setAnnotations] = useState<Row[]>([]);
  const { busy, create } = useCreate(props.resource, props);

  const problems = [
    ...(name && !NAME.test(name) ? ["Name: lowercase letters, digits, \"-\" and \".\"; starts and ends with a letter or digit"] : []),
    ...keyProblems(data, "Data", true),
    ...keyProblems(labels, "Labels", false),
    ...keyProblems(annotations, "Annotations", false),
  ];

  const submit = () => {
    const filled = data.filter((r) => r.key);
    // Files that are text go to data, anything else to binaryData.
    const text: Record<string, string> = {};
    const binary: Record<string, string> = {};
    for (const r of filled) {
      if (!r.file) text[r.key] = r.value;
      else {
        const t = b64ToText(r.file.b64);
        if (t === undefined) binary[r.key] = r.file.b64;
        else text[r.key] = t;
      }
    }
    create(namespace, name, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(name, namespace, labels, annotations),
      data: text,
      ...(Object.keys(binary).length ? { binaryData: binary } : {}),
    });
  };

  return (
    <Shell title="Create ConfigMap" problems={problems} busy={busy} onClose={props.onClose} onCreate={submit}>
      <NameAndNamespace kind="ConfigMap" {...{ name, setName, namespace, setNamespace }} namespaces={props.namespaces} />
      <KeyValues title="Data" rows={data} onChange={setData} files envPaste />
      <KeyValues title="Labels" rows={labels} onChange={setLabels} />
      <KeyValues title="Annotations" rows={annotations} onChange={setAnnotations} />
    </Shell>
  );
}

type SecretType =
  | "Opaque"
  | "kubernetes.io/dockerconfigjson"
  | "kubernetes.io/tls"
  | "kubernetes.io/basic-auth"
  | "kubernetes.io/ssh-auth"
  | "kubernetes.io/service-account-token";

const SECRET_TYPES: [SecretType, string][] = [
  ["Opaque", "Opaque"],
  ["kubernetes.io/dockerconfigjson", "Docker registry"],
  ["kubernetes.io/tls", "TLS"],
  ["kubernetes.io/basic-auth", "Basic auth"],
  ["kubernetes.io/ssh-auth", "SSH auth"],
  ["kubernetes.io/service-account-token", "Service account token"],
];

/** The keys a secret type requires, filled in when the type is chosen. */
function rowsFor(type: SecretType): Row[] {
  switch (type) {
    case "kubernetes.io/tls":
      return [
        row("tls.crt", { fixed: true, multiline: true, placeholder: "-----BEGIN CERTIFICATE----- (or load the file)" }),
        row("tls.key", { fixed: true, multiline: true, placeholder: "-----BEGIN PRIVATE KEY----- (or load the file)" }),
      ];
    case "kubernetes.io/basic-auth":
      return [row("username", { fixed: true }), row("password", { fixed: true })];
    case "kubernetes.io/ssh-auth":
      return [row("ssh-privatekey", { fixed: true, multiline: true, placeholder: "-----BEGIN OPENSSH PRIVATE KEY----- (or load the file)" })];
    case "kubernetes.io/dockerconfigjson":
    case "kubernetes.io/service-account-token":
      return [];
    default:
      return [row()];
  }
}

export function CreateSecretDialog(props: DialogProps) {
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState(props.namespace ?? "default");
  const [type, setTypeState] = useState<SecretType>("Opaque");
  const [data, setData] = useState<Row[]>(rowsFor("Opaque"));
  const [labels, setLabels] = useState<Row[]>([]);
  const [annotations, setAnnotations] = useState<Row[]>([]);
  const [registry, setRegistry] = useState({ server: "https://index.docker.io/v1/", username: "", password: "", email: "" });
  const [serviceAccount, setServiceAccount] = useState("");
  const { busy, create } = useCreate(props.resource, props);

  const setType = (t: SecretType) => {
    setTypeState(t);
    // The new type's required keys come first (keeping values typed for them); other entries stay.
    setData((rows) => {
      const typed = rows.filter((r) => !r.fixed && (r.key || r.value || r.file));
      const required = rowsFor(t)
        .filter((f) => f.fixed)
        .map((f) => {
          const same = typed.find((r) => r.key === f.key);
          return same ? { ...f, value: same.value, file: same.file } : f;
        });
      const rest = typed.filter((r) => !required.some((f) => f.key === r.key));
      const all = [...required, ...rest];
      return all.length ? all : rowsFor(t);
    });
  };

  const problems = [
    ...(name && !NAME.test(name) ? ["Name: lowercase letters, digits, \"-\" and \".\"; starts and ends with a letter or digit"] : []),
    ...(type === "kubernetes.io/dockerconfigjson" && (!registry.server || !registry.username || !registry.password)
      ? ["Registry server, username and password are required"]
      : []),
    ...(type === "kubernetes.io/service-account-token" && !serviceAccount ? ["Service account is required"] : []),
    ...keyProblems(data, "Data", true),
    ...keyProblems(labels, "Labels", false),
    ...keyProblems(annotations, "Annotations", false),
  ];

  const submit = () => {
    const values: Record<string, string> = {};
    for (const r of data.filter((r) => r.key)) values[r.key] = r.file ? r.file.b64 : utf8ToB64(r.value);
    if (type === "kubernetes.io/dockerconfigjson") {
      const auth = utf8ToB64(`${registry.username}:${registry.password}`);
      const entry = { username: registry.username, password: registry.password, auth, ...(registry.email ? { email: registry.email } : {}) };
      values[".dockerconfigjson"] = utf8ToB64(JSON.stringify({ auths: { [registry.server]: entry } }));
    }
    const ann = type === "kubernetes.io/service-account-token" ? [...annotations, row("kubernetes.io/service-account.name", { value: serviceAccount })] : annotations;
    create(namespace, name, {
      apiVersion: "v1",
      kind: "Secret",
      type,
      metadata: meta(name, namespace, labels, ann),
      data: values,
    });
  };

  return (
    <Shell title="Create Secret" problems={problems} busy={busy} onClose={props.onClose} onCreate={submit}>
      <NameAndNamespace
        kind="Secret"
        {...{ name, setName, namespace, setNamespace }}
        namespaces={props.namespaces}
        extra={
          <label className="field">
            Secret type
            <select value={type} onChange={(e) => setType(e.target.value as SecretType)}>
              {SECRET_TYPES.map(([t, label]) => (
                <option key={t} value={t}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {type === "kubernetes.io/dockerconfigjson" && (
        <div className="create-grid">
          {(
            [
              ["server", "Registry server *", "https://index.docker.io/v1/"],
              ["username", "Username *", "username"],
              ["password", "Password or token *", "password"],
              ["email", "Email", "you@example.com"],
            ] as const
          ).map(([k, label, placeholder]) => (
            <label key={k} className="field">
              {label}
              <input
                className="mono"
                type={k === "password" ? "password" : "text"}
                placeholder={placeholder}
                value={registry[k]}
                onChange={(e) => setRegistry((r) => ({ ...r, [k]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      {type === "kubernetes.io/service-account-token" && (
        <div className="create-grid">
          <label className="field">
            Service account *
            <input className="mono" placeholder="default" value={serviceAccount} onChange={(e) => setServiceAccount(e.target.value.trim())} />
          </label>
        </div>
      )}
      {type !== "kubernetes.io/service-account-token" && (
        <KeyValues title="Data" rows={data} onChange={setData} files envPaste={type === "Opaque"} />
      )}
      <KeyValues title="Labels" rows={labels} onChange={setLabels} />
      <KeyValues title="Annotations" rows={annotations} onChange={setAnnotations} />
      <div className="muted small">Values are base64-encoded for you.</div>
    </Shell>
  );
}
