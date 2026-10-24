import { useEffect, useState } from "react";
import { api, clusterApi, ContextInfo } from "../api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { clusterColor, clusterName, ClusterPrefs, initials, saveClusterPrefs, usePrefs } from "../prefs";
import { ClusterIcon } from "./ClusterIcon";
import { CodeEditor } from "./CodeEditor";
import { resetPrometheus } from "./Charts";
import { DEFAULT_RATES, detectCostSource, formatMoney, ratesFrom, resetCostCache } from "../cost";
import { Block, ListSetting, SettingsLayout, TextSetting, Toggle } from "./SettingsLayout";

const COLORS = ["#3d90ce", "#7a4dff", "#00a7a0", "#4caf50", "#c0a020", "#ff9800", "#ef5350", "#e0569b", "#607d8b", "#8d6e63"];
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

interface Props {
  ctx: ContextInfo;
  connected: boolean;
  initial?: string;
  onClose: () => void;
  onReconnect: () => void;
  onRemoved: () => void;
  onChanged: () => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
}

/** Per-cluster settings, split into sections. */
export function ClusterSettings({ ctx, connected, initial, onClose, onReconnect, onRemoved, onChanged, notify }: Props) {
  const prefs: ClusterPrefs = usePrefs().clusters[ctx.id] ?? {};
  const save = (patch: Partial<ClusterPrefs>, msg = "Saved") =>
    saveClusterPrefs(ctx.id, patch).then(
      () => notify(msg),
      (e) => notify(String(e), "bad"),
    );
  const needsReconnect = connected && (
    <span>
      Applies on the next connection.{" "}
      <a href="#" onClick={(e) => (e.preventDefault(), onReconnect())}>
        Reconnect now
      </a>
    </span>
  );

  const pickImage = async () => {
    const path = await openDialog({
      multiple: false,
      title: "Cluster icon",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (typeof path !== "string") return;
    try {
      await save({ iconImage: await api.loadIconImage(path) }, "Icon updated");
    } catch (e) {
      notify(String(e), "bad");
    }
  };

  const header = (
    <div className="settings-head">
      <ClusterIcon ctx={ctx} prefs={prefs} />
      <div className="grow">
        <div className="name">{clusterName(ctx, prefs)}</div>
        <div className="muted small">Cluster settings</div>
      </div>
    </div>
  );

  const sections = [
    {
      id: "general",
      label: "General",
      content: (
        <>
          <Block title="Name" hint={`Shown in the catalog and hotbar. Kubeconfig context: ${ctx.name}`}>
            <TextSetting value={prefs.name} placeholder={ctx.name} onSave={(name) => save({ name })} />
          </Block>
          <Block title="Icon" hint="A picture (PNG, JPEG, SVG… up to 512 KB), or up to 3 characters on a color (emoji work too).">
            <div className="btn-row">
              <ClusterIcon ctx={ctx} prefs={prefs} />
              <button onClick={pickImage}>Pick image…</button>
              {prefs.iconImage && (
                <button className="icon" onClick={() => save({ iconImage: null })}>
                  remove image
                </button>
              )}
            </div>
            <div className="btn-row">
              <div className="color-swatches">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch ${prefs.color === c ? "on" : ""}`}
                    style={{ background: c }}
                    onClick={() => save({ color: c })}
                    title={c}
                  />
                ))}
                <input type="color" value={clusterColor(ctx, prefs)} onChange={(e) => save({ color: e.target.value })} />
                {prefs.color && (
                  <button className="icon" onClick={() => save({ color: null })}>
                    reset color
                  </button>
                )}
              </div>
            </div>
            <div className="narrow">
              <TextSetting
                value={prefs.icon}
                placeholder={initials(clusterName(ctx, prefs))}
                onSave={(icon) => save({ icon: icon ? [...icon].slice(0, 3).join("") : null })}
              />
            </div>
          </Block>
          <Block title="Hotbar">
            <Toggle
              checked={!prefs.hideFromHotbar}
              onChange={(v) => save({ hideFromHotbar: !v })}
              label="Show this cluster in the hotbar"
            />
          </Block>
          <KubeconfigBlock ctx={ctx} connected={connected} onReconnect={onReconnect} onChanged={onChanged} notify={notify} />
          <Block
            title="Remove cluster"
            hint={
              ctx.pasted
                ? "Deletes this context from the kubeconfig Bens stored for you."
                : `Deletes context "${ctx.name}" (and its cluster/user entries if nothing else uses them) from ${ctx.file}. A backup is kept as ${ctx.file}.bens-backup.`
            }
          >
            <div>
              <button
                className="danger"
                onClick={async () => {
                  if (!confirm(`Remove context "${ctx.name}" from ${ctx.file}?`)) return;
                  try {
                    await api.deleteContext(ctx.file, ctx.name);
                    notify(`Removed ${ctx.name}`);
                    onRemoved();
                  } catch (e) {
                    notify(String(e), "bad");
                  }
                }}
              >
                Remove from kubeconfig
              </button>
            </div>
          </Block>
        </>
      ),
    },
    {
      id: "proxy",
      label: "Proxy",
      content: (
        <Block
          title="HTTP proxy"
          hint={
            <>
              Proxy for connections to this cluster's API server, e.g. http://proxy:3128 or socks5://127.0.0.1:1080.
              Overrides the proxy from Preferences. {needsReconnect}
            </>
          }
        >
          <TextSetting
            mono
            value={prefs.httpProxy}
            placeholder="http://<address>:<port>"
            onSave={(httpProxy) => save({ httpProxy })}
          />
        </Block>
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      content: (
        <>
          <Block
            title="Default namespace"
            hint="kubectl and helm in the cluster terminal use this namespace. Your kubeconfig is not modified."
          >
            <TextSetting
              mono
              value={prefs.terminalNamespace}
              placeholder={ctx.namespace ?? "default"}
              onSave={(terminalNamespace) => save({ terminalNamespace })}
            />
          </Block>
          <Block title="Working directory" hint="Where the cluster terminal starts. Empty = your home folder.">
            <TextSetting mono value={prefs.terminalCwd} placeholder="~" onSave={(terminalCwd) => save({ terminalCwd })} />
          </Block>
        </>
      ),
    },
    {
      id: "namespaces",
      label: "Namespaces",
      content: (
        <Block
          title="Accessible namespaces"
          hint="Useful when you are not allowed to list namespaces: these appear in the namespace picker."
        >
          <ListSetting
            items={prefs.accessibleNamespaces ?? []}
            placeholder="Add new namespace…"
            validate={(v) => (DNS_LABEL.test(v) ? undefined : "Not a valid namespace name")}
            onSave={(accessibleNamespaces) => save({ accessibleNamespaces })}
          />
        </Block>
      ),
    },
    {
      id: "metrics",
      label: "Metrics",
      content: <MetricsSettings cluster={ctx.id} prefs={prefs} save={save} connected={connected} />,
    },
    {
      id: "cost",
      label: "Cost",
      content: <CostSettings cluster={ctx.id} prefs={prefs} save={save} connected={connected} />,
    },
    {
      id: "node-shell",
      label: "Node shell",
      content: (
        <>
          <Block title="Node shell image" hint="Image of the privileged pod used for node shells. Needs nsenter (alpine, busybox…).">
            <TextSetting
              mono
              value={prefs.nodeShellImage}
              placeholder="Default image: docker.io/alpine:3.19"
              onSave={(nodeShellImage) => save({ nodeShellImage })}
            />
          </Block>
          <Block title="Image pull secret" hint="Secret in kube-system to pull the node shell image from a private registry.">
            <TextSetting
              mono
              value={prefs.nodeShellPullSecret}
              placeholder="Specify a secret name…"
              onSave={(nodeShellPullSecret) => save({ nodeShellPullSecret })}
            />
          </Block>
        </>
      ),
    },
  ];

  return <SettingsLayout header={header} sections={sections} initial={initial} onClose={onClose} />;
}

function KubeconfigBlock({
  ctx,
  connected,
  onReconnect,
  onChanged,
  notify,
}: Pick<Props, "ctx" | "connected" | "onReconnect" | "onChanged" | "notify">) {
  const [text, setText] = useState<string>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = text !== undefined && draft !== text;

  const open = () =>
    api.readKubeconfig(ctx.file).then(
      (t) => {
        setText(t);
        setDraft(t);
      },
      (e) => notify(String(e), "bad"),
    );

  const saveFile = async () => {
    setBusy(true);
    try {
      await api.writeKubeconfig(ctx.file, draft);
      setText(draft);
      notify("Kubeconfig saved");
      onChanged();
      if (connected && confirm("Kubeconfig saved. Reconnect to apply the changes?")) onReconnect();
    } catch (e) {
      notify(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Block
      title="Kubeconfig"
      hint={
        text !== undefined
          ? `Editing the whole file — it may contain other contexts too. The previous version is kept as ${ctx.file}.bens-backup.`
          : undefined
      }
    >
      <div className="btn-row">
        <span className="mono small grow path">{ctx.file}</span>
        <button onClick={() => api.reveal(ctx.file).catch((e) => notify(String(e), "bad"))}>Show in Finder</button>
        {text === undefined ? (
          <button onClick={open}>Edit</button>
        ) : (
          <>
            <button disabled={!dirty || busy} onClick={() => setDraft(text)}>
              Revert
            </button>
            <button className="primary" disabled={!dirty || busy} onClick={saveFile}>
              Save
            </button>
            <button onClick={() => (!dirty || confirm("Discard changes?")) && setText(undefined)}>Close</button>
          </>
        )}
      </div>
      {text !== undefined && (
        <div className="settings-editor">
          <CodeEditor value={draft} onChange={setDraft} onSave={saveFile} />
        </div>
      )}
    </Block>
  );
}

function MetricsSettings({
  cluster,
  prefs,
  save,
  connected,
}: {
  cluster: string;
  prefs: ClusterPrefs;
  save: (p: Partial<ClusterPrefs>, msg?: string) => Promise<void>;
  connected: boolean;
}) {
  const mode = prefs.prometheusMode ?? "auto";
  const [detected, setDetected] = useState<string>();
  const hidden = prefs.hiddenMetrics ?? [];

  const savePrometheus = (patch: Partial<ClusterPrefs>) => save(patch).then(() => resetPrometheus(cluster));

  useEffect(() => {
    if (!connected) return;
    setDetected("checking…");
    clusterApi(cluster)
      .prometheusDetect()
      .then((s) => setDetected(s ? `${s.namespace}/${s.service}:${s.port}` : "not found"))
      .catch((e) => setDetected(String(e)));
  }, [cluster, connected, mode, prefs.prometheusService, prefs.prometheusPrefix]);

  return (
    <>
      <Block
        title="Prometheus"
        hint={
          <>
            Queried through the API server's service proxy — no port-forward needed.
            {connected && detected && (
              <>
                {" "}
                Current: <span className="mono">{detected}</span>
              </>
            )}
          </>
        }
      >
        <div className="seg narrow">
          {(["auto", "manual", "off"] as const).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => savePrometheus({ prometheusMode: m })}>
              {m === "auto" ? "Auto detect" : m === "manual" ? "Manual" : "Off"}
            </button>
          ))}
        </div>
      </Block>
      {mode === "manual" && (
        <Block title="Prometheus service address" hint="Service of your Prometheus (or VictoriaMetrics / Thanos query).">
          <TextSetting
            mono
            value={prefs.prometheusService}
            placeholder="<namespace>/<service>:<port>"
            onSave={(prometheusService) => savePrometheus({ prometheusService })}
          />
        </Block>
      )}
      {mode !== "off" && (
        <Block title="Path prefix" hint="If Prometheus is served under a sub-path, e.g. /prometheus.">
          <TextSetting
            mono
            value={prefs.prometheusPrefix}
            placeholder="/"
            onSave={(prometheusPrefix) => savePrometheus({ prometheusPrefix })}
          />
        </Block>
      )}
      <Block title="Show metrics">
        {(
          [
            ["cluster", "Cluster charts on Overview"],
            ["node", "Node charts"],
            ["pod", "Pod charts"],
          ] as const
        ).map(([g, label]) => (
          <Toggle
            key={g}
            checked={!hidden.includes(g)}
            label={label}
            onChange={(on) => save({ hiddenMetrics: on ? hidden.filter((h) => h !== g) : [...hidden, g] })}
          />
        ))}
      </Block>
    </>
  );
}

const COST_SOURCES = [
  ["auto", "Auto detect"],
  ["kubecost", "Kubecost"],
  ["opencost", "OpenCost"],
  ["estimated", "Estimate"],
  ["off", "Off"],
] as const;

function CostSettings({
  cluster,
  prefs,
  save,
  connected,
}: {
  cluster: string;
  prefs: ClusterPrefs;
  save: (p: Partial<ClusterPrefs>, msg?: string) => Promise<void>;
  connected: boolean;
}) {
  const source = prefs.costSource ?? "auto";
  const [detected, setDetected] = useState<string>();
  const rates = ratesFrom(prefs);
  const saveCost = (patch: Partial<ClusterPrefs>) => save(patch).then(() => resetCostCache());
  const number = (v: string | null, key: keyof ClusterPrefs, scale = 1) => {
    if (v === null) return saveCost({ [key]: null });
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return Promise.resolve(alert("Enter a non-negative number"));
    return saveCost({ [key]: n / scale });
  };

  useEffect(() => {
    if (!connected) return;
    setDetected("checking…");
    detectCostSource(clusterApi(cluster), prefs).then(
      (d) =>
        setDetected(
          d.status === "detected"
            ? `${d.source.name} (${d.source.handle})`
            : d.status === "failed"
              ? d.error
              : d.status === "off"
                ? "off"
                : "nothing found",
        ),
      (e) => setDetected(String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, source, prefs.costAddress, prefs.prometheusMode, prefs.prometheusService]);

  const example = 4 * rates.cpu + 16 * rates.ram;

  return (
    <>
      <Block
        title="Cost source"
        hint={
          <>
            Auto detect tries Kubecost, then OpenCost (found by their Helm labels and queried through the API server's
            service proxy), then an estimate from Prometheus usage.
            {connected && detected && (
              <>
                {" "}
                Current: <span className="mono">{detected}</span>
              </>
            )}
          </>
        }
      >
        <div className="seg">
          {COST_SOURCES.map(([id, label]) => (
            <button key={id} className={source === id ? "on" : ""} onClick={() => saveCost({ costSource: id })}>
              {label}
            </button>
          ))}
        </div>
      </Block>
      {(source === "kubecost" || source === "opencost") && (
        <Block
          title="Service address"
          hint={`Where ${source === "kubecost" ? "Kubecost's cost-analyzer (port 9090)" : "OpenCost's API (port 9003)"} runs, if detection can't find it. Empty = find it.`}
        >
          <TextSetting mono value={prefs.costAddress} placeholder="<namespace>/<service>:<port>" onSave={(costAddress) => saveCost({ costAddress })} />
        </Block>
      )}
      {(source === "auto" || source === "estimated") && (
        <>
          <Block
            title="Estimate rates"
            hint={
              <>
                Used when the cluster runs no cost backend. Defaults are OpenCost's (GCP on-demand list prices). Set your
                cloud's prices to get figures in its currency — e.g. for Yandex Cloud, the price of a vCPU-hour and a
                GiB-hour of RAM in RUB. Example: a 4-core 16 GiB node costs {formatMoney(example, rates.currency)}/h, about{" "}
                {formatMoney(example * 730, rates.currency)}/month.
              </>
            }
          >
            <div className="rate-grid">
              <label className="field">
                Currency
                <TextSetting
                  mono
                  value={prefs.costCurrency}
                  placeholder={DEFAULT_RATES.currency}
                  onSave={(v) => {
                    if (v && !/^[a-zA-Z]{3}$/.test(v.trim())) return alert("Use a 3-letter currency code, e.g. USD, EUR, RUB");
                    saveCost({ costCurrency: v?.trim().toUpperCase() || null });
                  }}
                />
              </label>
              <label className="field">
                CPU, per core-hour
                <TextSetting mono value={prefs.costCpuRate?.toString()} placeholder={String(DEFAULT_RATES.cpu)} onSave={(v) => number(v, "costCpuRate")} />
              </label>
              <label className="field">
                Memory, per GiB-hour
                <TextSetting mono value={prefs.costRamRate?.toString()} placeholder={String(DEFAULT_RATES.ram)} onSave={(v) => number(v, "costRamRate")} />
              </label>
              <label className="field">
                Spot / preemptible discount, %
                <TextSetting
                  mono
                  value={prefs.costSpotDiscount == null ? null : String(+(prefs.costSpotDiscount * 100).toFixed(2))}
                  placeholder={(DEFAULT_RATES.spotDiscount * 100).toFixed(0)}
                  onSave={(v) => (v !== null && Number(v) > 100 ? alert("At most 100%") : number(v, "costSpotDiscount", 100))}
                />
              </label>
            </div>
          </Block>
        </>
      )}
    </>
  );
}
