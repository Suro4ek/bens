import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, House, Search, Settings } from "lucide-react";
import type { Connection, ContextInfo } from "../api";
import { NAV_ICONS } from "../icons";
import { buildNavTree, NavNode, pathTo } from "../nav";
import { clusterName, usePrefs } from "../prefs";
import { storage } from "../util";
import { ClusterIcon } from "./ClusterIcon";

interface Props {
  contexts: ContextInfo[];
  /** Connected clusters by catalog id; each shows its own section tree. */
  connections: Record<string, Connection>;
  /** Clusters being connected. */
  connecting: string[];
  /** The view on screen: its cluster and view id. */
  current?: { cluster: string; view: string };
  onConnect: (ctx: ContextInfo) => void;
  onSettings: (ctx: ContextInfo) => void;
  /** Right click on a cluster: its menu (connect, reconnect, settings…). */
  onClusterMenu: (ctx: ContextInfo, x: number, y: number) => void;
  onPick: (cluster: string, viewId: string) => void;
  onHome: () => void;
  onSearch: () => void;
}

const WIDTH_KEY = "navigatorWidth";
const OPEN_KEY = "navigatorOpen";

/** Navigator: a tree of kubeconfigs → clusters → each connected cluster's resources. */
export function Navigator({ contexts, connections, connecting, current, onConnect, onSettings, onClusterMenu, onPick, onHome, onSearch }: Props) {
  const { clusters } = usePrefs();
  const trees = useMemo(
    () => Object.fromEntries(Object.entries(connections).map(([id, c]) => [id, buildNavTree(c.resources)])),
    [connections],
  );
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(storage.get(OPEN_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  const [width, setWidth] = useState(() => Number(storage.get(WIDTH_KEY)) || 280);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const setOpenKey = (key: string, value: boolean) =>
    setOpen((o) => {
      const next = { ...o, [key]: value };
      storage.set(OPEN_KEY, JSON.stringify(next));
      return next;
    });
  const isOpen = (key: string, def = false) => open[key] ?? def;
  // Group keys are per cluster: opening Workloads in one cluster leaves the others as they are.
  const groupKey = (cluster: string, key: string) => `${cluster}|${key}`;

  // Reveal the active view in the tree.
  useEffect(() => {
    if (!current) return;
    const path = pathTo(trees[current.cluster] ?? [], current.view)?.map((k) => groupKey(current.cluster, k));
    const keys = path ? [...path, `c:${current.cluster}`] : [];
    if (keys.some((k) => !open[k])) {
      setOpen((o) => {
        const next = { ...o };
        keys.forEach((k) => (next[k] = true));
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.cluster, current?.view, trees]);

  const row = (cluster: string, n: NavNode, depth: number) => {
    const Icon = n.icon ? NAV_ICONS[n.icon] : undefined;
    const key = groupKey(cluster, n.key);
    const expanded = isOpen(key);
    const active = !!n.id && current?.cluster === cluster && n.id === current.view;
    return (
      <div key={n.key}>
        <div
          className={`tree-row ${active ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (n.children ? setOpenKey(key, !expanded) : n.id && onPick(cluster, n.id))}
        >
          <span className={`chev ${n.children ? "" : "none"} ${expanded ? "open" : ""}`}>
            {n.children && <ChevronRight size={14} />}
          </span>
          {Icon && <Icon size={15} className="tree-icon" />}
          <span className="tree-label">{n.label}</span>
        </div>
        {n.children && expanded && <div className="tree-children">{n.children.map((c) => row(cluster, c, depth + 1))}</div>}
      </div>
    );
  };

  const rootOpen = isOpen("root", true);

  return (
    <aside className="navigator" style={{ width }}>
      <div className="navigator-head">
        <span className="navigator-tab">Navigator</span>
      </div>
      <div className="navigator-tools">
        <button className="home-select" onClick={onHome} title="Catalog">
          <House size={14} /> Home
        </button>
        <button className="icon" onClick={onSearch} title="Search (⌘K)">
          <Search size={16} />
        </button>
      </div>
      <div className="tree">
        <div className="tree-row" style={{ paddingLeft: 8 }} onClick={() => setOpenKey("root", !rootOpen)}>
          <span className={`chev ${rootOpen ? "open" : ""}`}>
            <ChevronRight size={14} />
          </span>
          <span className="tree-label">Local Kubeconfigs</span>
        </div>
        {rootOpen &&
          contexts.map((c) => {
            const p = clusters[c.id];
            const connected = !!connections[c.id];
            const expanded = connected && isOpen(`c:${c.id}`, true);
            return (
              <div key={c.id} className="tree-children">
                <div
                  className={`tree-row cluster ${connected ? "connected" : ""} ${current?.cluster === c.id ? "focused" : ""}`}
                  style={{ paddingLeft: 22 }}
                  title={`${c.name}\n${c.server ?? ""}\n${c.file}`}
                  onClick={() => (connected ? setOpenKey(`c:${c.id}`, !expanded) : onConnect(c))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onClusterMenu(c, e.clientX, e.clientY);
                  }}
                >
                  <span className={`chev ${expanded ? "open" : ""}`}>
                    <ChevronRight size={14} />
                  </span>
                  <ClusterIcon ctx={c} prefs={p} className="mini-icon" />
                  <span className="tree-label">{clusterName(c, p)}</span>
                  {connecting.includes(c.id) && <span className="spinner tiny" />}
                  {connected && <span className="dot ok" title="Connected" />}
                  <button
                    className="icon row-action"
                    title="Cluster settings"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSettings(c);
                    }}
                  >
                    <Settings size={13} />
                  </button>
                </div>
                {expanded && <div className="tree-children">{(trees[c.id] ?? []).map((n) => row(c.id, n, 2))}</div>}
              </div>
            );
          })}
        {rootOpen && contexts.length === 0 && <div className="tree-empty muted small">No kubeconfigs found</div>}
      </div>
      <div
        className="navigator-resizer"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setWidth(Math.min(Math.max(drag.current.w + e.clientX - drag.current.x, 200), 520));
        }}
        onPointerUp={() => {
          drag.current = null;
          storage.set(WIDTH_KEY, String(width));
        }}
      />
    </aside>
  );
}
