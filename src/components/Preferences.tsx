import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Contexts } from "../api";
import { AppPrefs, saveAppPrefs, useAppPrefs } from "../prefs";
import { Block, NumberSetting, SettingsLayout, TextSetting, Toggle } from "./SettingsLayout";

interface Props {
  catalog: Contexts;
  onClose: () => void;
  onChanged: () => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}

const SOURCE_LABEL = { sync: "synced", env: "$KUBECONFIG", pasted: "added in Bens" } as const;

/** App-wide preferences. */
export function Preferences({ catalog, onClose, onChanged, notify }: Props) {
  const p = useAppPrefs();
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  const save = (patch: Partial<AppPrefs>) => saveAppPrefs(patch).catch((e) => notify(String(e), "bad"));

  const addSource = async (directory: boolean) => {
    const path = await open({ directory, multiple: false, title: directory ? "Folder with kubeconfigs" : "Kubeconfig file" });
    if (typeof path !== "string") return;
    try {
      await api.addKubeconfigPath(path);
      notify(`Syncing ${path}`);
      onChanged();
    } catch (e) {
      notify(String(e), "bad");
    }
  };
  const removeSource = async (path: string) => {
    if (!confirm(`Stop syncing ${path}?`)) return;
    await api.removeKubeconfigSource(path).catch((e) => notify(String(e), "bad"));
    onChanged();
  };

  const sections = [
    {
      id: "app",
      label: "App",
      content: (
        <>
          <Block title="Theme">
            <div className="seg narrow">
              {(["dark", "light", "system"] as const).map((t) => (
                <button key={t} className={p.theme === t ? "on" : ""} onClick={() => save({ theme: t })}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </Block>
          <Block title="Start-up">
            <Toggle
              checked={p.reconnectLast}
              onChange={(reconnectLast) => save({ reconnectLast })}
              label="Reopen the last cluster on start"
            />
          </Block>
          <Block title="Logs" hint="Lines of history loaded when opening pod logs.">
            <NumberSetting value={p.logTailLines} min={10} max={100000} onSave={(logTailLines) => save({ logTailLines })} />
          </Block>
          <Block title="About">
            <div className="muted small">Bens {version} — a Kubernetes IDE on Tauri + Rust.</div>
          </Block>
        </>
      ),
    },
    {
      id: "kubernetes",
      label: "Kubernetes",
      content: (
        <>
          <Block
            title="Kubeconfig syncs"
            hint="Files are read in place; for folders every kubeconfig directly inside is used. Changes show up on catalog refresh."
          >
            <div className="btn-row">
              <button onClick={() => addSource(false)}>Sync file…</button>
              <button onClick={() => addSource(true)}>Sync folder…</button>
            </div>
            <div className="list-setting">
              {catalog.sources.map((s) => (
                <div key={s.path + s.kind} className="list-item">
                  <span className="mono grow">{s.path}</span>
                  <span className="chip">{SOURCE_LABEL[s.kind]}</span>
                  <span className="muted small">
                    {s.exists ? `${s.contexts} context${s.contexts === 1 ? "" : "s"}` : "missing"}
                  </span>
                  {s.kind === "sync" && (
                    <button className="icon" title="Stop syncing" onClick={() => removeSource(s.path)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Block>
          <Block title="Helm binary" hint="Used for releases, repositories and chart installs. Empty = helm from your PATH.">
            <TextSetting mono value={p.helmPath} placeholder="helm" onSave={(v) => save({ helmPath: v ?? "" })} />
          </Block>
        </>
      ),
    },
    {
      id: "proxy",
      label: "Proxy",
      content: (
        <>
          <Block
            title="HTTP proxy"
            hint="Used for API server connections of all clusters, unless a cluster sets its own proxy. http:// or socks5://. Applies on the next connection."
          >
            <TextSetting mono value={p.httpProxy} placeholder="http://<address>:<port>" onSave={(v) => save({ httpProxy: v ?? "" })} />
          </Block>
          <Block
            title="Certificate trust"
            hint="Skips TLS verification of API servers. Only for clusters with self-signed certificates that are not in their kubeconfig — it makes man-in-the-middle attacks possible."
          >
            <Toggle
              checked={p.allowUntrustedCa}
              onChange={(allowUntrustedCa) => save({ allowUntrustedCa })}
              label="Allow untrusted Certificate Authorities"
            />
          </Block>
        </>
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      content: (
        <>
          <Block title="Shell path" hint="Shell for the cluster terminal. Empty = your login shell ($SHELL).">
            <TextSetting mono value={p.shell} placeholder="/bin/zsh" onSave={(v) => save({ shell: v ?? "" })} />
          </Block>
          <Block title="Font size">
            <NumberSetting value={p.terminalFontSize} min={8} max={32} onSave={(terminalFontSize) => save({ terminalFontSize })} />
          </Block>
          <Block title="Font family" hint="Any installed monospace font, e.g. JetBrains Mono, Fira Code.">
            <TextSetting
              value={p.terminalFontFamily}
              placeholder="SF Mono / Menlo"
              onSave={(v) => save({ terminalFontFamily: v ?? "" })}
            />
          </Block>
          <Block title="Selection">
            <Toggle
              checked={p.terminalCopyOnSelect}
              onChange={(terminalCopyOnSelect) => save({ terminalCopyOnSelect })}
              label="Copy on select"
            />
          </Block>
        </>
      ),
    },
    {
      id: "editor",
      label: "Editor",
      content: (
        <>
          <Block title="Font size">
            <NumberSetting value={p.editorFontSize} min={8} max={32} onSave={(editorFontSize) => save({ editorFontSize })} />
          </Block>
          <Block title="Tab size">
            <NumberSetting value={p.editorTabSize} min={1} max={8} onSave={(editorTabSize) => save({ editorTabSize })} />
          </Block>
          <Block title="Lines">
            <Toggle checked={p.editorLineWrap} onChange={(editorLineWrap) => save({ editorLineWrap })} label="Wrap long lines" />
          </Block>
        </>
      ),
    },
  ];

  return (
    <SettingsLayout
      header={
        <div className="settings-head">
          <div className="name">Preferences</div>
        </div>
      }
      sections={sections}
      onClose={onClose}
    />
  );
}
