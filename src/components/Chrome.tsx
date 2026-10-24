import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Cable, Plus, Search, SquareTerminal, X } from "lucide-react";
import type { Connection, ContextInfo } from "../api";
import { viewIcon } from "../icons";
import { clusterName, ClusterPrefs } from "../prefs";
import { ClusterIcon } from "./ClusterIcon";
import { useForwards } from "./PortForwards";
import { ContextMenu, tabMenuItems } from "./ObjectMenu";

const isMac = navigator.userAgent.includes("Mac");

/** Window title bar (the native one is hidden on macOS): history arrows and global actions. */
export function TitleBar({
  canBack,
  canForward,
  onBack,
  onForward,
  onSearch,
  onCreate,
  onTerminal,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onSearch: () => void;
  onCreate?: () => void;
  onTerminal?: () => void;
}) {
  return (
    <header className={`titlebar ${isMac ? "mac" : ""}`} data-tauri-drag-region>
      <button className="icon" disabled={!canBack} onClick={onBack} title="Back (⌘[)">
        <ArrowLeft size={16} />
      </button>
      <button className="icon" disabled={!canForward} onClick={onForward} title="Forward (⌘])">
        <ArrowRight size={16} />
      </button>
      <div className="titlebar-fill" data-tauri-drag-region />
      <button className="title-search" onClick={onSearch} title="Command palette">
        <Search size={13} />
        <span>Search resources, clusters, commands…</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="titlebar-fill" data-tauri-drag-region />
      {onCreate && (
        <button className="icon" onClick={onCreate} title="Create resource from YAML (⌘N)">
          <Plus size={17} />
        </button>
      )}
      {onTerminal && (
        <button className="icon" onClick={onTerminal} title="Cluster terminal (⌘`)">
          <SquareTerminal size={16} />
        </button>
      )}
    </header>
  );
}

export interface MainTab {
  id: string;
  /** Full title, with the cluster name for cluster tabs ("Pods - minikube"). */
  title: string;
  /** View id, for the icon. */
  view: string;
  /** Color of the tab's top line when active: its cluster's color. */
  accent?: string;
}

/** Tabs above the main area. */
export function MainTabs({
  tabs,
  active,
  onActivate,
  onClose,
  onCloseMany,
}: {
  tabs: MainTab[];
  active?: string;
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
  onCloseMany?: (ids: string[], fallback?: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  // Keep the active tab in view when it changes (opened from the Navigator, ⌘[ / ⌘], …).
  useEffect(() => {
    strip.current?.querySelector(".main-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active, tabs.length]);

  return (
    <div className="main-tabs-bar">
    <div
      ref={strip}
      className="main-tabs"
      // A mouse wheel scrolls vertically; turn it into horizontal scrolling of the strip.
      onWheel={(e) => {
        if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((t) => {
        const Icon = viewIcon(t.view);
        return (
          <div
            key={t.id}
            className={`main-tab ${t.id === active ? "active" : ""}`}
            style={t.accent ? ({ "--tab-accent": t.accent } as React.CSSProperties) : undefined}
            onClick={() => onActivate(t.id)}
            onAuxClick={(e) => e.button === 1 && onClose?.(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (onCloseMany) setTabMenu({ x: e.clientX, y: e.clientY, id: t.id });
            }}
            title={t.title}
          >
            <Icon size={15} className="tab-icon" />
            <span className="tab-title">{t.title}</span>
            {onClose && (
              <button
                className="icon tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
      {tabMenu && onCloseMany && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabs.map((t) => t.id), tabMenu.id, onCloseMany)}
          onClose={() => setTabMenu(null)}
        />
      )}
      {tabs.length > 1 && (
        <div className="tabs-menu">
          <button className="icon" title="All open tabs" onClick={() => setMenu((m) => !m)}>
            <ChevronDown size={16} />
          </button>
          {menu && (
            <>
              <div className="menu-backdrop" onClick={() => setMenu(false)} />
              <div className="menu">
                {tabs.map((t) => {
                  const Icon = viewIcon(t.view);
                  return (
                    <div
                      key={t.id}
                      className={`menu-item ${t.id === active ? "active" : ""}`}
                      onClick={() => {
                        onActivate(t.id);
                        setMenu(false);
                      }}
                    >
                      <Icon size={14} /> <span className="grow ellipsis">{t.title}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function StatusBar({
  ctx,
  prefs,
  conn,
  namespace,
  onForwards,
}: {
  ctx?: ContextInfo;
  prefs?: ClusterPrefs;
  conn: Connection | null;
  namespace: string | null;
  onForwards: () => void;
}) {
  const forwards = useForwards(ctx?.id);
  return (
    <footer className="statusbar">
      {ctx && conn ? (
        <span className="status-item">
          <ClusterIcon ctx={ctx} prefs={prefs} className="micro-icon" />
          {clusterName(ctx, prefs)} ({conn.serverVersion})
        </span>
      ) : (
        <span className="status-item muted">No cluster connected</span>
      )}
      {conn && <span className="status-item muted">namespace: {namespace ?? "all"}</span>}
      <div className="spacer" />
      {conn && forwards.length > 0 && (
        <button className="status-item link" onClick={onForwards}>
          <Cable size={12} /> {forwards.length} port forward{forwards.length === 1 ? "" : "s"}
        </button>
      )}
      {conn && <span className="status-item muted">{conn.metrics ? "metrics-server" : "no metrics-server"}</span>}
    </footer>
  );
}
