import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Plus, X } from "lucide-react";
import type { KubeObject, ResourceInfo } from "../api";
import { DOCK_ICONS } from "../icons";
import { storage } from "../util";
import { LogsSource, LogsView } from "./LogsView";
import { ShellView } from "./ShellView";
import { CreateView, YamlView } from "./YamlView";
import { ContextMenu, tabMenuItems } from "./ObjectMenu";
import { ClusterContext } from "../clusterContext";

/** A dock tab, bound to the cluster it was opened for (it keeps running while other clusters are shown). */
export type DockTab = { id: string; cluster: string; title: string } & (
  | { type: "logs"; source: LogsSource; container?: string }
  | { type: "shell"; pod?: KubeObject; node?: string; container?: string }
  | { type: "yaml"; resource: ResourceInfo; obj: KubeObject }
  | { type: "create"; namespace: string | null; initial?: string }
);

interface Props {
  tabs: DockTab[];
  active?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseMany: (ids: string[], fallback?: string) => void;
  onNewTerminal: () => void;
  /** Cluster name shown on the tab when several clusters are connected. */
  clusterLabel?: (cluster: string) => string | undefined;
}

const HEIGHT_KEY = "dockHeight";

/** Bottom dock (terminals, logs, editors): the tab strip is always there. */
export function Dock({ tabs, active, onActivate, onClose, onCloseMany, onNewTerminal, clusterLabel }: Props) {
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [height, setHeight] = useState(() => Number(storage.get(HEIGHT_KEY)) || 320);
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const open = tabs.length > 0 && !collapsed;

  return (
    <div className={`dock ${open ? "open" : ""} ${maximized && open ? "maximized" : ""}`} style={open && !maximized ? { height } : undefined}>
      {open && !maximized && (
        <div
          className="dock-resizer"
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, h: height };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const h = drag.current.h + (drag.current.y - e.clientY);
            setHeight(Math.min(Math.max(h, 140), window.innerHeight - 160));
          }}
          onPointerUp={() => {
            drag.current = null;
            storage.set(HEIGHT_KEY, String(height));
          }}
        />
      )}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabs.map((t) => t.id), tabMenu.id, onCloseMany)}
          onClose={() => setTabMenu(null)}
        />
      )}
      <div className="dock-tabs">
        {tabs.map((t) => {
          const Icon = DOCK_ICONS[t.type];
          return (
            <div
              key={t.id}
              className={`dock-tab ${t.id === active && open ? "active" : ""}`}
              onClick={() => {
                onActivate(t.id);
                setCollapsed(false);
              }}
              onAuxClick={(e) => e.button === 1 && onClose(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, id: t.id });
              }}
              title={clusterLabel?.(t.cluster) ? `${t.title} - ${clusterLabel(t.cluster)}` : t.title}
            >
              <Icon size={14} className="dock-icon" />
              <span className="dock-title">
                {t.title}
                {clusterLabel?.(t.cluster) && <span className="muted"> - {clusterLabel(t.cluster)}</span>}
              </span>
              <button
                className="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
        <button
          className="icon dock-add"
          title="New terminal (⌘`)"
          onClick={() => {
            onNewTerminal();
            setCollapsed(false);
          }}
        >
          <Plus size={16} />
        </button>
        <div className="spacer" />
        {tabs.length > 0 && (
          <>
            <button className="icon" onClick={() => (setMaximized((m) => !m), setCollapsed(false))} title={maximized ? "Restore" : "Fit to window"}>
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button className="icon" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Open" : "Minimize"}>
              {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </>
        )}
      </div>
      {tabs.map((t) => (
        // All tabs stay mounted so shells and log streams survive tab switches and collapsing.
        <div key={t.id} className="dock-body" style={{ display: open && t.id === active ? "flex" : "none" }}>
          <ClusterContext.Provider value={t.cluster}>
            {t.type === "logs" && <LogsView source={t.source} initialContainer={t.container} />}
            {t.type === "shell" && <ShellView pod={t.pod} node={t.node} container={t.container} active={t.id === active && open} />}
            {t.type === "yaml" && <YamlView resource={t.resource} obj={t.obj} />}
            {t.type === "create" && <CreateView namespace={t.namespace} initial={t.initial} />}
          </ClusterContext.Provider>
        </div>
      ))}
    </div>
  );
}
