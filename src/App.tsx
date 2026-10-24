import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Connection, ContextInfo, Contexts, KubeObject, newId, ResourceInfo } from "./api";
import { Catalog } from "./components/Catalog";
import { MainTab, MainTabs, StatusBar, TitleBar } from "./components/Chrome";
import { ClusterSettings } from "./components/ClusterSettings";
import { ClusterView, Navigate } from "./components/ClusterView";
import { Preferences } from "./components/Preferences";
import { Command, CommandPalette } from "./components/CommandPalette";
import type { DockActions } from "./components/DetailsPanel";
import { Dock, DockTab } from "./components/Dock";
import { resetPrometheus } from "./components/Charts";
import { Hotbar } from "./components/Hotbar";
import { ALL_NAMESPACES as ALL } from "./components/NamespaceSelect";
import { Navigator } from "./components/Navigator";
import { ContextMenu } from "./components/ObjectMenu";
import { ARGO, COST, FLUX, HELM, navId, OVERVIEW, PORT_FORWARDS, pluralTitle, viewTitle } from "./nav";
import { clusterMenuItems } from "./clusterMenu";
import { storage } from "./util";
import { clusterColor, clusterName, getAppPrefs, saveClusterPrefs, usePrefs } from "./prefs";

/** The catalog of clusters; available with or without a connection. */
const CATALOG = "catalog";
const MAX_TABS = 30;

/**
 * Main tabs of all connected clusters share one strip, as "Pods - minikube".
 * A tab id is the cluster's catalog id and the view id; the catalog's is CATALOG.
 */
const SEP = "::";
export const tabId = (cluster: string, view: string) => `${cluster}${SEP}${view}`;
export function parseTab(id: string | undefined): { cluster: string; view: string } | null {
  if (!id || id === CATALOG) return null;
  const i = id.lastIndexOf(SEP);
  return i < 0 ? null : { cluster: id.slice(0, i), view: id.slice(i + SEP.length) };
}
const clusterOf = (id: string | undefined) => parseTab(id)?.cluster;

interface HistoryEntry {
  tab: string;
  selected?: string;
}

/** Views a cluster had open last time (its tabs are reopened on connect). */
const savedViews = (id: string): string[] => {
  try {
    const t = JSON.parse(storage.get(`tabs:${id}`) ?? "null");
    return Array.isArray(t) && t.length ? t : [OVERVIEW];
  } catch {
    return [OVERVIEW];
  }
};

/** Clusters that were connected when the app was closed. */
function savedOpenClusters(): string[] {
  try {
    const list = JSON.parse(storage.get("openClusters") ?? "null");
    if (Array.isArray(list)) return list;
  } catch {
    /* fall back to the single last cluster */
  }
  const last = storage.get("lastContext");
  return last ? [last] : [];
}

export default function App() {
  const [contexts, setContexts] = useState<Contexts>({ contexts: [], sources: [] });
  /** Connected clusters by catalog id. Several can be connected at once. */
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [connecting, setConnecting] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [mainTabs, setMainTabs] = useState<string[]>([CATALOG]);
  const [activeTab, setActiveTab] = useState<string>(CATALOG);
  /** Selected object per main tab. */
  const [selection, setSelection] = useState<Record<string, string | undefined>>({});
  /** Namespace filter per cluster (ALL for all namespaces). */
  const [namespaces, setNamespaces] = useState<Record<string, string>>({});
  const [namespaceNames, setNamespaceNames] = useState<Record<string, string[]>>({});
  const [dockTabs, setDockTabs] = useState<DockTab[]>([]);
  const [activeDock, setActiveDock] = useState<string>();
  /** The cluster last on screen: where new terminals and "Create" go while the catalog is shown. */
  const [focused, setFocused] = useState<string>();
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [clusterMenu, setClusterMenu] = useState<{ ctx: ContextInfo; x: number; y: number } | null>(null);
  const openClusterMenu = useCallback((ctx: ContextInfo, x: number, y: number) => setClusterMenu({ ctx, x, y }), []);
  /** Full-page settings shown over the current view (which stays mounted). */
  const [page, setPage] = useState<{ kind: "prefs" } | { kind: "cluster"; id: string; section?: string } | null>(null);
  const [detailsSlot, setDetailsSlot] = useState<HTMLDivElement | null>(null);
  const prefs = usePrefs();
  const autoConnected = useRef(false);
  const history = useRef<{ entries: HistoryEntry[]; index: number }>({ entries: [{ tab: CATALOG }], index: 0 });
  const [, setHistoryTick] = useState(0);
  // Current values for callbacks that outlive a render (connect, disconnect).
  const live = useRef({ mainTabs, activeTab });
  live.current = { mainTabs, activeTab };

  const current = parseTab(activeTab);
  const focusedCluster = current?.cluster ?? (focused && connections[focused] ? focused : undefined);
  const contextOf = (id?: string) => contexts.contexts.find((c) => c.id === id);
  const labelOf = (id: string) => {
    const c = contextOf(id);
    return c ? clusterName(c, prefs.clusters[id]) : id;
  };

  const notify = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    setToast({ text, tone });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 4000);
  }, []);

  const refreshContexts = useCallback(() => {
    api
      .listContexts()
      .then(setContexts)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(refreshContexts, [refreshContexts]);

  const pushHistory = (tab: string, selected?: string) => {
    const h = history.current;
    const cur = h.entries[h.index];
    if (cur?.tab === tab && cur?.selected === selected) return;
    h.entries = [...h.entries.slice(0, h.index + 1), { tab, selected }].slice(-100);
    h.index = h.entries.length - 1;
    setHistoryTick((n) => n + 1);
  };

  /** Shows a tab: focuses it or opens it, like Lens. */
  const show = useCallback((tab: string, sel?: string) => {
    setMainTabs((t) => {
      if (t.includes(tab)) return t;
      const next = [...t, tab];
      return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
    });
    setActiveTab(tab);
    setSelection((s) => ({ ...s, [tab]: sel }));
  }, []);

  const navigate = useCallback(
    (tab: string, sel?: string) => {
      show(tab, sel);
      pushHistory(tab, sel);
    },
    [show],
  );

  /** Navigation inside one cluster (Navigator, links in details, dashboards). */
  const navigateIn = useCallback(
    (cluster: string): Navigate =>
      (view, uid, ref) => {
        navigate(tabId(cluster, view), ref ? `ref:${ref.namespace ?? ""}/${ref.name}` : uid);
        // Make sure the target is visible under the namespace filter.
        if (ref?.namespace)
          setNamespaces((n) => (n[cluster] && n[cluster] !== ALL && n[cluster] !== ref.namespace ? { ...n, [cluster]: ALL } : n));
      },
    [navigate],
  );

  /** Brings a connected cluster to the front: its last view, or Overview. */
  const focusCluster = useCallback(
    (id: string) => {
      const tabs = live.current.mainTabs.filter((t) => clusterOf(t) === id);
      const last = storage.get(`view:${id}`);
      const tab = last && tabs.includes(tabId(id, last)) ? tabId(id, last) : (tabs.at(-1) ?? tabId(id, OVERVIEW));
      navigate(tab);
    },
    [navigate],
  );

  const connect = useCallback(
    async (ctx: ContextInfo) => {
      setConnecting((c) => [...c.filter((x) => x !== ctx.id), ctx.id]);
      setError(undefined);
      try {
        const c = await api.connect(ctx);
        resetPrometheus(ctx.id);
        setConnections((m) => ({ ...m, [ctx.id]: c }));
        setNamespaces((n) => ({ ...n, [ctx.id]: n[ctx.id] ?? storage.get(`ns:${ctx.id}`) ?? ALL }));
        storage.set("lastContext", ctx.id);
        // A reconnect keeps the cluster's tabs; a new connection reopens the ones it had last time.
        const open = live.current.mainTabs.filter((t) => clusterOf(t) === ctx.id);
        if (!open.length) {
          const views = savedViews(ctx.id);
          // Opened from the catalog: the cluster's tabs take its place.
          const dropCatalog = live.current.activeTab === CATALOG;
          setMainTabs((t) => [
            ...t.filter((x) => !(dropCatalog && x === CATALOG)),
            ...views.map((v) => tabId(ctx.id, v)).filter((x) => !t.includes(x)),
          ]);
          const last = storage.get(`view:${ctx.id}`);
          navigate(tabId(ctx.id, last && views.includes(last) ? last : views[0]));
        } else if (clusterOf(live.current.activeTab) !== ctx.id) {
          focusCluster(ctx.id);
        }
      } catch (e) {
        setError(`${ctx.name}: ${e}`);
        setMainTabs((t) => (t.includes(CATALOG) ? t : [CATALOG, ...t]));
        navigate(CATALOG);
      } finally {
        setConnecting((c) => c.filter((x) => x !== ctx.id));
      }
    },
    [navigate, focusCluster],
  );

  /** Catalog, hotbar: show a connected cluster, connect another one. */
  const openCluster = useCallback(
    (ctx: ContextInfo) => (connections[ctx.id] ? focusCluster(ctx.id) : connect(ctx)),
    [connections, focusCluster, connect],
  );

  // Reopen the clusters that were connected last time.
  useEffect(() => {
    if (autoConnected.current || !contexts.contexts.length) return;
    autoConnected.current = true;
    if (!getAppPrefs().reconnectLast) return;
    for (const id of savedOpenClusters()) {
      const ctx = contexts.contexts.find((c) => c.id === id);
      if (ctx) connect(ctx);
    }
  }, [contexts, connect]);

  const disconnect = useCallback(
    (id: string) => {
      api.disconnect(id);
      setConnections(({ [id]: _, ...rest }) => rest);
      const remaining = live.current.mainTabs.filter((t) => clusterOf(t) !== id);
      const tabs = remaining.length ? remaining : [CATALOG];
      setMainTabs(tabs);
      if (clusterOf(live.current.activeTab) === id) setActiveTab(tabs.at(-1)!);
      setDockTabs((t) => t.filter((x) => x.cluster !== id));
      const h = history.current;
      h.entries = h.entries.filter((e) => clusterOf(e.tab) !== id);
      if (!h.entries.length) h.entries = [{ tab: CATALOG }];
      h.index = h.entries.length - 1;
      setHistoryTick((n) => n + 1);
      refreshContexts();
    },
    [refreshContexts],
  );

  // Remember which clusters are connected, and each one's tabs and last view.
  useEffect(() => {
    if (!autoConnected.current) return;
    storage.set("openClusters", JSON.stringify(Object.keys(connections)));
  }, [connections]);
  useEffect(() => {
    for (const id of Object.keys(connections)) {
      const views = mainTabs.filter((t) => clusterOf(t) === id).map((t) => parseTab(t)!.view);
      if (views.length) storage.set(`tabs:${id}`, JSON.stringify(views));
    }
  }, [connections, mainTabs]);
  useEffect(() => {
    if (!current) return;
    setFocused(current.cluster);
    storage.set(`view:${current.cluster}`, current.view);
    storage.set("lastContext", current.cluster);
  }, [current?.cluster, current?.view]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (delta: number) => {
    const h = history.current;
    let i = h.index + delta;
    // Skip entries of clusters that were disconnected since.
    while (i >= 0 && i < h.entries.length && clusterOf(h.entries[i].tab) && !connections[clusterOf(h.entries[i].tab)!]) i += delta;
    if (i < 0 || i >= h.entries.length) return;
    h.index = i;
    show(h.entries[i].tab, h.entries[i].selected);
    setHistoryTick((n) => n + 1);
  };

  /** Closes tabs; `fallback` becomes active if the current one closes. */
  const closeMainTabs = (ids: string[], fallback?: string) => {
    const next = mainTabs.filter((x) => !ids.includes(x));
    setMainTabs(next.length ? next : [CATALOG]);
    if (ids.includes(activeTab)) {
      const i = mainTabs.indexOf(activeTab);
      setActiveTab(fallback && next.includes(fallback) ? fallback : (next[Math.min(i, next.length - 1)] ?? CATALOG));
    }
  };
  const closeMainTab = (id: string) => closeMainTabs([id]);

  const select = (sel?: string) => {
    setSelection((s) => ({ ...s, [activeTab]: sel }));
    const h = history.current;
    const cur = h.entries[h.index];
    if (cur) h.entries[h.index] = { tab: activeTab, selected: sel };
  };

  const openDock = (tab: DockTab) => {
    setDockTabs((t) => [...t, tab]);
    setActiveDock(tab.id);
  };
  const closeDockTabs = (ids: string[], fallback?: string) =>
    setDockTabs((t) => {
      const next = t.filter((x) => !ids.includes(x.id));
      if (activeDock && ids.includes(activeDock))
        setActiveDock(fallback && next.some((x) => x.id === fallback) ? fallback : next[next.length - 1]?.id);
      return next;
    });
  const closeDockTab = (id: string) => closeDockTabs([id]);

  /** Dock actions of one cluster: the tabs they open stay bound to it. */
  const actionsFor = (cluster: string): DockActions => ({
    openLogs: (pod: KubeObject, container?: string) =>
      openDock({ id: newId("tab"), cluster, type: "logs", title: `Logs: ${pod.metadata.name}`, source: { pod }, container }),
    openWorkloadLogs: (resource: ResourceInfo, obj: KubeObject) =>
      openDock({
        id: newId("tab"),
        cluster,
        type: "logs",
        title: `Logs: ${resource.kind} ${obj.metadata.name}`,
        source: { workload: { resource, obj } },
      }),
    openShell: (pod: KubeObject, container?: string) =>
      openDock({ id: newId("tab"), cluster, type: "shell", title: `Shell: ${pod.metadata.name}`, pod, container }),
    openYaml: (resource: ResourceInfo, obj: KubeObject) =>
      openDock({ id: newId("tab"), cluster, type: "yaml", title: `${resource.kind}: ${obj.metadata.name}`, resource, obj }),
    openNodeShell: (node: KubeObject) =>
      openDock({ id: newId("tab"), cluster, type: "shell", title: `Node: ${node.metadata.name}`, node: node.metadata.name }),
    openCreate: (yaml?: string) => openCreate(cluster, yaml),
  });
  const nsParamOf = (cluster: string) => (namespaces[cluster] && namespaces[cluster] !== ALL ? namespaces[cluster] : null);
  const openTerminal = (cluster = focusedCluster) =>
    cluster && openDock({ id: newId("tab"), cluster, type: "shell", title: "Terminal" });
  const openCreate = (cluster = focusedCluster, initial?: string) =>
    cluster && openDock({ id: newId("tab"), cluster, type: "create", title: "Create resource", namespace: nsParamOf(cluster), initial });

  const pickNamespace = useCallback((cluster: string, ns: string) => {
    setNamespaces((n) => ({ ...n, [cluster]: ns }));
    storage.set(`ns:${cluster}`, ns);
  }, []);
  const reportNamespaces = useCallback(
    (cluster: string) => (names: string[]) => setNamespaceNames((n) => (n[cluster] === names ? n : { ...n, [cluster]: names })),
    [],
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const fc = focusedCluster;
    const conn = fc ? connections[fc] : undefined;
    if (fc && conn) {
      const to = (view: string) => () => navigate(tabId(fc, view));
      list.push(
        { id: "a:overview", label: "Overview", hint: "view", run: to(OVERVIEW) },
        { id: "a:pf", label: "Port Forwarding", hint: "view", run: to(PORT_FORWARDS) },
        { id: "a:helm", label: "Helm Releases", hint: "view", run: to(HELM) },
        { id: "a:flux", label: "Flux dashboard", hint: "gitops", run: to(FLUX) },
        { id: "a:argo", label: "Argo CD dashboard", hint: "gitops", run: to(ARGO) },
        { id: "a:cost", label: "Cost Monitoring", hint: "view", run: to(COST) },
        { id: "a:term", label: "Open cluster terminal", hint: "action", run: () => openTerminal(fc) },
        { id: "a:create", label: "Create resource from YAML", hint: "action", run: () => openCreate(fc) },
        ...conn.resources.map((r) => ({ id: `r:${r.key}`, label: pluralTitle(r), hint: r.group || "core", run: to(navId(r)) })),
        { id: "n:all", label: "All namespaces", hint: "namespace", run: () => pickNamespace(fc, ALL) },
        ...(namespaceNames[fc] ?? []).map((n) => ({ id: `n:${n}`, label: n, hint: "namespace", run: () => pickNamespace(fc, n) })),
        { id: "a:csettings", label: "Cluster settings", hint: "settings", run: () => setPage({ kind: "cluster", id: fc }) },
        { id: "a:disconnect", label: `Disconnect from ${labelOf(fc)}`, hint: "action", run: () => disconnect(fc) },
      );
    }
    list.push(
      ...contexts.contexts.map((c) => ({
        id: `c:${c.id}`,
        label: clusterName(c, prefs.clusters[c.id]),
        hint: connections[c.id] ? "cluster · connected" : "cluster",
        run: () => openCluster(c),
      })),
      { id: "a:catalog", label: "Catalog", hint: "clusters", run: () => navigate(CATALOG) },
      { id: "a:prefs", label: "Preferences", hint: "settings", run: () => setPage({ kind: "prefs" }) },
      ...contexts.contexts.map((c) => ({
        id: `s:${c.id}`,
        label: `Settings: ${clusterName(c, prefs.clusters[c.id])}`,
        hint: "cluster settings",
        run: () => setPage({ kind: "cluster", id: c.id }),
      })),
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedCluster, connections, namespaceNames, contexts, navigate, openCluster, disconnect, prefs.clusters]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        setPage({ kind: "prefs" });
      } else if (page) {
        return; // settings page handles its own keys
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.key.toLowerCase() === "n" && focusedCluster) {
        e.preventDefault();
        openCreate();
      } else if (mod && e.key === "`" && focusedCluster) {
        e.preventDefault();
        openTerminal();
      } else if (mod && e.key === "[") {
        e.preventDefault();
        go(-1);
      } else if (mod && e.key === "]") {
        e.preventDefault();
        go(1);
      } else if (mod && e.key.toLowerCase() === "w" && !(e.target as HTMLElement).closest(".dock")) {
        e.preventDefault();
        closeMainTab(activeTab);
      } else if (e.key === "Escape" && !palette) {
        select(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const focusedCtx = contextOf(focusedCluster);
  const settingsCtx = page?.kind === "cluster" ? contextOf(page.id) : undefined;
  const h = history.current;
  const shownTabs: MainTab[] = mainTabs.flatMap((id): MainTab[] => {
    const t = parseTab(id);
    if (!t) return [{ id, title: "Catalog", view: CATALOG }];
    const conn = connections[t.cluster];
    const ctx = contextOf(t.cluster);
    if (!conn || !ctx) return [];
    const p = prefs.clusters[t.cluster];
    return [{ id, title: `${viewTitle(t.view, conn.resources)} - ${clusterName(ctx, p)}`, view: t.view, accent: clusterColor(ctx, p) }];
  });
  const connectedIds = Object.keys(connections);
  const activeConn = current ? connections[current.cluster] : undefined;

  return (
    <div className="app">
      <TitleBar
        canBack={h.index > 0}
        canForward={h.index < h.entries.length - 1}
        onBack={() => go(-1)}
        onForward={() => go(1)}
        onSearch={() => setPalette(true)}
        onCreate={focusedCluster ? () => openCreate() : undefined}
        onTerminal={focusedCluster ? () => openTerminal() : undefined}
      />
      <div className="workspace">
        <Hotbar
          contexts={contexts.contexts}
          active={current?.cluster}
          connected={connectedIds}
          connecting={connecting}
          onPick={openCluster}
          onClusterMenu={openClusterMenu}
          onHome={() => {
            setPage(null);
            navigate(CATALOG);
          }}
          onPreferences={() => setPage({ kind: "prefs" })}
        />
        <Navigator
          contexts={contexts.contexts}
          connections={connections}
          connecting={connecting}
          current={current ?? undefined}
          onConnect={connect}
          onSettings={(c) => setPage({ kind: "cluster", id: c.id })}
          onClusterMenu={openClusterMenu}
          onPick={(cluster, view) => navigate(tabId(cluster, view))}
          onHome={() => navigate(CATALOG)}
          onSearch={() => setPalette(true)}
        />
        <div className="main">
          <MainTabs
            tabs={shownTabs}
            active={activeTab}
            onActivate={(id) => navigate(id, selection[id])}
            onClose={closeMainTab}
            onCloseMany={closeMainTabs}
          />
          <div className="main-body">
            <div className="main-left">
              <div className="content">
                {!current && (
                  <Catalog
                    catalog={contexts}
                    connecting={connecting}
                    connected={connectedIds}
                    error={error}
                    onPick={openCluster}
                    onSettings={(c) => setPage({ kind: "cluster", id: c.id })}
                    onChanged={refreshContexts}
                    notify={notify}
                  />
                )}
                {current && activeConn && (
                  <ClusterView
                    key={current.cluster}
                    cluster={current.cluster}
                    conn={activeConn}
                    prefs={prefs.clusters[current.cluster] ?? {}}
                    view={current.view}
                    selected={selection[activeTab]}
                    namespace={namespaces[current.cluster] ?? ALL}
                    onNamespace={(ns) => pickNamespace(current.cluster, ns)}
                    onSelect={select}
                    onNavigate={navigateIn(current.cluster)}
                    onNamespaceNames={reportNamespaces(current.cluster)}
                    onOpenSettings={(section) => setPage({ kind: "cluster", id: current.cluster, section })}
                    actions={actionsFor(current.cluster)}
                    notify={notify}
                    detailsSlot={detailsSlot}
                  />
                )}
              </div>
              {connectedIds.length > 0 && (
                <Dock
                  tabs={dockTabs}
                  active={activeDock}
                  onActivate={setActiveDock}
                  onClose={closeDockTab}
                  onCloseMany={closeDockTabs}
                  onNewTerminal={() => openTerminal()}
                  clusterLabel={connectedIds.length > 1 ? labelOf : undefined}
                />
              )}
            </div>
            {/* The details drawer spans the full height next to the list and the dock. */}
            <div ref={setDetailsSlot} className="details-slot" />
          </div>
        </div>
      </div>
      <StatusBar
        ctx={focusedCtx}
        prefs={focusedCluster ? prefs.clusters[focusedCluster] : undefined}
        conn={focusedCluster ? (connections[focusedCluster] ?? null) : null}
        namespace={focusedCluster ? nsParamOf(focusedCluster) : null}
        onForwards={() => focusedCluster && navigate(tabId(focusedCluster, PORT_FORWARDS))}
      />
      {page?.kind === "prefs" && (
        <Preferences catalog={contexts} onClose={() => setPage(null)} onChanged={refreshContexts} notify={notify} />
      )}
      {settingsCtx && (
        <ClusterSettings
          key={settingsCtx.id}
          ctx={settingsCtx}
          connected={!!connections[settingsCtx.id]}
          initial={page?.kind === "cluster" ? page.section : undefined}
          onClose={() => setPage(null)}
          onReconnect={() => {
            setPage(null);
            connect(settingsCtx);
          }}
          onRemoved={() => {
            setPage(null);
            if (connections[settingsCtx.id]) disconnect(settingsCtx.id);
            else refreshContexts();
          }}
          onChanged={refreshContexts}
          notify={notify}
        />
      )}
      {clusterMenu && (
        <ContextMenu
          x={clusterMenu.x}
          y={clusterMenu.y}
          onClose={() => setClusterMenu(null)}
          items={clusterMenuItems(
            clusterMenu.ctx,
            {
              active: !!connections[clusterMenu.ctx.id],
              connecting: connecting.includes(clusterMenu.ctx.id),
              prefs: prefs.clusters[clusterMenu.ctx.id],
            },
            {
              connect: (c) => {
                setPage(null);
                connect(c);
              },
              disconnect: (c) => disconnect(c.id),
              settings: (c) => setPage({ kind: "cluster", id: c.id }),
              terminal: (c) => openTerminal(c.id),
              setHotbar: (c, shown) => saveClusterPrefs(c.id, { hideFromHotbar: !shown }).catch((e) => notify(String(e), "bad")),
              copy: (text) => navigator.clipboard.writeText(text).then(() => notify(`Copied ${text}`)),
              reveal: (path) => api.reveal(path).catch((e) => notify(String(e), "bad")),
              remove: async (c) => {
                if (!confirm(`Remove context "${c.name}" from ${c.file}?\n\nA backup is kept as ${c.file}.bens-backup.`)) return;
                try {
                  await api.deleteContext(c.file, c.name);
                  notify(`Removed ${c.name}`);
                  if (connections[c.id]) disconnect(c.id);
                  else refreshContexts();
                } catch (e) {
                  notify(String(e), "bad");
                }
              },
            },
          )}
        />
      )}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
