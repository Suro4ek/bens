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
  activeId?: string;
  connecting?: string;
  connection: Connection | null;
  /** Active view id. */
  current?: string;
  onConnect: (ctx: ContextInfo) => void;
  onSettings: (ctx: ContextInfo) => void;
  onPick: (viewId: string) => void;
  onHome: () => void;
  onSearch: () => void;
}

const WIDTH_KEY = "navigatorWidth";
const OPEN_KEY = "navigatorOpen";

/** Navigator: a tree of kubeconfigs → clusters → the connected cluster's resources. */
export function Navigator({ contexts, activeId, connecting, connection, current, onConnect, onSettings, onPick, onHome, onSearch }: Props) {
  const { clusters } = usePrefs();
  const tree = useMemo(() => (connection ? buildNavTree(connection.resources) : []), [connection]);
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

  // Reveal the active view in the tree.
  useEffect(() => {
    if (!current) return;
    const path = pathTo(tree, current);
    if (path?.some((k) => !open[k])) {
      setOpen((o) => {
        const next = { ...o };
        path.forEach((k) => (next[k] = true));
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, tree]);

  const row = (n: NavNode, depth: number) => {
    const Icon = n.icon ? NAV_ICONS[n.icon] : undefined;
    const expanded = isOpen(n.key);
    return (
      <div key={n.key}>
        <div
          className={`tree-row ${n.id && n.id === current ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (n.children ? setOpenKey(n.key, !expanded) : n.id && onPick(n.id))}
        >
          <span className={`chev ${n.children ? "" : "none"} ${expanded ? "open" : ""}`}>
            {n.children && <ChevronRight size={14} />}
          </span>
          {Icon && <Icon size={15} className="tree-icon" />}
          <span className="tree-label">{n.label}</span>
        </div>
        {n.children && expanded && <div className="tree-children">{n.children.map((c) => row(c, depth + 1))}</div>}
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
            const active = c.id === activeId;
            const expanded = active && isOpen(`c:${c.id}`, true);
            return (
              <div key={c.id} className="tree-children">
                <div
                  className={`tree-row cluster ${active ? "connected" : ""}`}
                  style={{ paddingLeft: 22 }}
                  title={`${c.name}\n${c.server ?? ""}\n${c.file}`}
                  onClick={() => (active ? setOpenKey(`c:${c.id}`, !expanded) : onConnect(c))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSettings(c);
                  }}
                >
                  <span className={`chev ${expanded ? "open" : ""}`}>
                    <ChevronRight size={14} />
                  </span>
                  <ClusterIcon ctx={c} prefs={p} className="mini-icon" />
                  <span className="tree-label">{clusterName(c, p)}</span>
                  {connecting === c.id && <span className="spinner tiny" />}
                  {active && <span className="dot ok" title="Connected" />}
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
                {expanded && <div className="tree-children">{tree.map((n) => row(n, 2))}</div>}
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
