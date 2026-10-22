import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Connection, ContextInfo, Contexts, KubeObject, newId, ResourceInfo } from "./api";
import { Catalog } from "./components/Catalog";
import { MainTabs, StatusBar, TitleBar } from "./components/Chrome";
import { ClusterSettings } from "./components/ClusterSettings";
import { Preferences } from "./components/Preferences";
import { Command, CommandPalette } from "./components/CommandPalette";
import { DetailsPanel } from "./components/DetailsPanel";
import { Dock, DockTab } from "./components/Dock";
import { resetPrometheus } from "./components/Charts";
import { ArgoDashboard, FluxDashboard } from "./components/GitOpsDashboards";
import { CostDashboard } from "./components/CostDashboard";
import { HelmReleases } from "./components/HelmReleases";
import { Hotbar } from "./components/Hotbar";
import { ALL_NAMESPACES as ALL, NamespaceContext } from "./components/NamespaceSelect";
import { Navigator } from "./components/Navigator";
import { Overview } from "./components/Overview";
import { PortForwards } from "./components/PortForwards";
import { ResourceTable } from "./components/ResourceTable";
import { ARGO, COST, FLUX, HELM, navId, OVERVIEW, PORT_FORWARDS, pluralTitle, SPECIAL_VIEWS, viewTitle } from "./nav";
import { useMetrics } from "./useMetrics";
import type { Column } from "./columns";
import { allocatedInSlice, allocationMap, CLAIMS, SLICES } from "./dra";
import { useWatch } from "./useWatch";
import { storage } from "./util";
import { clusterColor, clusterName, getAppPrefs, saveClusterPrefs, setActiveCluster, usePrefs } from "./prefs";
import { clusterMenuItems } from "./clusterMenu";
import { ContextMenu } from "./components/ObjectMenu";

/** The catalog of clusters; available with or without a connection. */
const CATALOG = "catalog";
const MAX_TABS = 15;

interface HistoryEntry {
  view: string;
  selected?: string;
}

const savedTabs = (id: string): string[] => {
  try {
    const t = JSON.parse(storage.get(`tabs:${id}`) ?? "null");
    return Array.isArray(t) && t.length ? t : [OVERVIEW];
  } catch {
    return [OVERVIEW];
  }
};

export default function App() {
  const [contexts, setContexts] = useState<Contexts>({ contexts: [], sources: [] });
  const [conn, setConn] = useState<Connection | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const [connecting, setConnecting] = useState<string>();
  const [error, setError] = useState<string>();
  /** Open main tabs (view ids) and the active one. */
  const [mainTabs, setMainTabs] = useState<string[]>([CATALOG]);
  const [view, setView] = useState<string | undefined>(CATALOG);
  const [namespace, setNamespace] = useState<string>(ALL);
  const [selected, setSelected] = useState<string>();
  const [tabs, setTabs] = useState<DockTab[]>([]);
  const [activeTab, setActiveTab] = useState<string>();
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  /** Full-page settings shown over the current view (which stays mounted). */
  const [clusterMenu, setClusterMenu] = useState<{ ctx: ContextInfo; x: number; y: number } | null>(null);
  const openClusterMenu = useCallback((ctx: ContextInfo, x: number, y: number) => setClusterMenu({ ctx, x, y }), []);
  const [page, setPage] = useState<{ kind: "prefs" } | { kind: "cluster"; id: string; section?: string } | null>(null);
  const prefs = usePrefs();
  const clusterPrefs = activeId ? prefs.clusters[activeId] : undefined;
  const connectSeq = useRef(0);
  const autoConnected = useRef(false);
  const history = useRef<{ entries: HistoryEntry[]; index: number }>({ entries: [{ view: CATALOG }], index: 0 });
  const [, setHistoryTick] = useState(0);

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

  const resetHistory = (entry: HistoryEntry) => {
    history.current = { entries: [entry], index: 0 };
    setHistoryTick((n) => n + 1);
  };

  const connect = useCallback(async (ctx: ContextInfo) => {
    const seq = ++connectSeq.current;
    setConnecting(ctx.id);
    setError(undefined);
    try {
      const c = await api.connect(ctx);
      if (seq !== connectSeq.current) return;
      resetPrometheus();
      setConn(c);
      setActiveId(ctx.id);
      setTabs([]);
      setSelected(undefined);
      setNamespace(storage.get(`ns:${ctx.id}`) ?? ALL);
      const open = savedTabs(ctx.id);
      const last = storage.get(`view:${ctx.id}`);
      const v = last && open.includes(last) ? last : open[0];
      setMainTabs(open);
      setView(v);
      resetHistory({ view: v });
      storage.set("lastContext", ctx.id);
    } catch (e) {
      if (seq !== connectSeq.current) return;
      setError(`${ctx.name}: ${e}`);
      setView(CATALOG);
      setMainTabs((t) => (t.includes(CATALOG) ? t : [CATALOG, ...t]));
    } finally {
      if (seq === connectSeq.current) setConnecting(undefined);
    }
  }, []);

  // Reopen the cluster that was open last time.
  useEffect(() => {
    if (autoConnected.current || !contexts.contexts.length) return;
    autoConnected.current = true;
    const last = contexts.contexts.find((c) => c.id === storage.get("lastContext"));
    if (last && getAppPrefs().reconnectLast) connect(last);
  }, [contexts, connect]);

  const disconnect = useCallback(() => {
    connectSeq.current++;
    setConnecting(undefined);
    setConn(null);
    setActiveId(undefined);
    setTabs([]);
    setMainTabs([CATALOG]);
    setView(CATALOG);
    resetHistory({ view: CATALOG });
    storage.set("lastContext", "");
    api.disconnect();
    refreshContexts();
  }, [refreshContexts]);

  useEffect(() => setActiveCluster(activeId), [activeId]);

  // Remember open tabs per cluster.
  useEffect(() => {
    if (!activeId) return;
    storage.set(`tabs:${activeId}`, JSON.stringify(mainTabs.filter((t) => t !== CATALOG)));
    if (view && view !== CATALOG) storage.set(`view:${activeId}`, view);
  }, [activeId, mainTabs, view]);

  const byNav = useMemo(() => new Map((conn?.resources ?? []).map((r) => [navId(r), r])), [conn]);
  const resource = view && conn && !(view in SPECIAL_VIEWS) && view !== CATALOG ? byNav.get(view) : undefined;
  const nsParam = namespace === ALL ? null : namespace;
  const namespaces = useWatch(conn ? byNav.get("/namespaces")?.key : undefined, null);
  // Namespaces from the cluster plus the ones configured as accessible (for users who can't list them).
  const namespaceNames = useMemo(
    () =>
      [...new Set([...namespaces.items.map((n) => n.metadata.name), ...(clusterPrefs?.accessibleNamespaces ?? [])])].sort(),
    [namespaces.items, clusterPrefs?.accessibleNamespaces],
  );
  const watch = useWatch(resource?.key, resource?.namespaced ? nsParam : null);
  // Selection is a uid, or `ref:<namespace>/<name>` when navigating by name (e.g. from Argo CD resources).
  const selectedObj = watch.items.find(
    (o) => o.metadata.uid === selected || `ref:${o.metadata.namespace ?? ""}/${o.metadata.name}` === selected,
  );

  // Resource Slices show how many of their devices are allocated, which only the claims know.
  const claimsKey = conn?.resources.find((r) => navId(r) === CLAIMS)?.key;
  const claims = useWatch(view === SLICES ? claimsKey : undefined, null);
  const sliceColumns = useMemo((): Column[] | undefined => {
    if (view !== SLICES || !claimsKey || claims.error) return undefined;
    const map = allocationMap(claims.items);
    return [{ title: "Allocated", value: (o) => allocatedInSlice(o, map), width: "90px" }];
  }, [view, claimsKey, claims.items, claims.error]);

  const metricsOn = !!conn?.metrics;
  const podMetrics = useMetrics("pods", nsParam, metricsOn && view === "/pods");
  const nodeMetrics = useMetrics("nodes", null, metricsOn && (view === "/nodes" || view === OVERVIEW));

  /** Shows a view: focuses its tab or opens a new one. */
  const show = useCallback((id: string, sel?: string) => {
    setMainTabs((t) => {
      if (t.includes(id)) return t;
      const next = [...t, id];
      return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
    });
    setView(id);
    setSelected(sel);
  }, []);

  const navigate = useCallback(
    (id: string, uid?: string, ref?: { namespace?: string; name: string }) => {
      const sel = ref ? `ref:${ref.namespace ?? ""}/${ref.name}` : uid;
      show(id, sel);
      // Make sure the target is visible under the namespace filter.
      if (ref?.namespace && namespace !== ALL && ref.namespace !== namespace) setNamespace(ALL);
      const h = history.current;
      const cur = h.entries[h.index];
      if (cur?.view !== id || cur?.selected !== sel) {
        h.entries = [...h.entries.slice(0, h.index + 1), { view: id, selected: sel }].slice(-100);
        h.index = h.entries.length - 1;
        setHistoryTick((n) => n + 1);
      }
    },
    [namespace, show],
  );

  const go = (delta: number) => {
    const h = history.current;
    const i = h.index + delta;
    if (i < 0 || i >= h.entries.length) return;
    h.index = i;
    const e = h.entries[i];
    if (!conn && e.view !== CATALOG) return;
    show(e.view, e.selected);
    setHistoryTick((n) => n + 1);
  };

  const closeMainTab = (id: string) => {
    setMainTabs((t) => {
      const i = t.indexOf(id);
      const next = t.filter((x) => x !== id);
      if (id === view) {
        setView(next[Math.min(i, next.length - 1)]);
        setSelected(undefined);
      }
      return next;
    });
  };

  /** Closes several tabs at once (tab menu); `fallback` becomes active if the current one closes. */
  const closeMainTabs = (ids: string[], fallback?: string) => {
    setMainTabs((t) => {
      const next = t.filter((x) => !ids.includes(x));
      if (view && ids.includes(view)) {
        setView(fallback && next.includes(fallback) ? fallback : next[next.length - 1]);
        setSelected(undefined);
      }
      return next;
    });
  };

  // Keep the selection in sync with the browser-like history when the details panel changes.
  const select = (uid?: string) => {
    setSelected(uid);
    const h = history.current;
    const cur = h.entries[h.index];
    if (cur && view) h.entries[h.index] = { ...cur, view, selected: uid };
  };

  const openTab = (tab: DockTab) => {
    setTabs((t) => [...t, tab]);
    setActiveTab(tab.id);
  };
  const closeTabs = (ids: string[], fallback?: string) =>
    setTabs((t) => {
      const next = t.filter((x) => !ids.includes(x.id));
      if (activeTab && ids.includes(activeTab)) setActiveTab(fallback && next.some((x) => x.id === fallback) ? fallback : next[next.length - 1]?.id);
      return next;
    });
  const closeTab = (id: string) =>
    setTabs((t) => {
      const next = t.filter((x) => x.id !== id);
      if (id === activeTab) setActiveTab(next[next.length - 1]?.id);
      return next;
    });

  const actions = {
    openLogs: (pod: KubeObject, container?: string) =>
      openTab({ id: newId("tab"), type: "logs", title: `Logs: ${pod.metadata.name}`, source: { pod }, container }),
    openWorkloadLogs: (resource: ResourceInfo, obj: KubeObject) =>
      openTab({ id: newId("tab"), type: "logs", title: `Logs: ${resource.kind} ${obj.metadata.name}`, source: { workload: { resource, obj } } }),
    openShell: (pod: KubeObject, container?: string) =>
      openTab({ id: newId("tab"), type: "shell", title: `Shell: ${pod.metadata.name}`, pod, container }),
    openYaml: (res: ResourceInfo, obj: KubeObject) =>
      openTab({ id: newId("tab"), type: "yaml", title: `${res.kind}: ${obj.metadata.name}`, resource: res, obj }),
    openNodeShell: (node: KubeObject) =>
      openTab({ id: newId("tab"), type: "shell", title: `Node: ${node.metadata.name}`, node: node.metadata.name }),
  };
  const openTerminal = () => conn && openTab({ id: newId("tab"), type: "shell", title: "Terminal" });
  const openCreate = () => conn && openTab({ id: newId("tab"), type: "create", title: "Create resource", namespace: nsParam });

  const pickNamespace = useCallback(
    (ns: string) => {
      setNamespace(ns);
      if (activeId) storage.set(`ns:${activeId}`, ns);
    },
    [activeId],
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (conn) {
      list.push(
        { id: "a:overview", label: "Overview", hint: "view", run: () => navigate(OVERVIEW) },
        { id: "a:pf", label: "Port Forwarding", hint: "view", run: () => navigate(PORT_FORWARDS) },
        { id: "a:helm", label: "Helm Releases", hint: "view", run: () => navigate(HELM) },
        { id: "a:flux", label: "Flux dashboard", hint: "gitops", run: () => navigate(FLUX) },
        { id: "a:argo", label: "Argo CD dashboard", hint: "gitops", run: () => navigate(ARGO) },
        { id: "a:cost", label: "Cost Monitoring", hint: "view", run: () => navigate(COST) },
        { id: "a:term", label: "Open cluster terminal", hint: "action", run: openTerminal },
        { id: "a:create", label: "Create resource from YAML", hint: "action", run: openCreate },
        ...conn.resources.map((r) => ({
          id: `r:${r.key}`,
          label: pluralTitle(r),
          hint: r.group || "core",
          run: () => navigate(navId(r)),
        })),
        { id: "n:all", label: "All namespaces", hint: "namespace", run: () => pickNamespace(ALL) },
        ...namespaceNames.map((n) => ({
          id: `n:${n}`,
          label: n,
          hint: "namespace",
          run: () => pickNamespace(n),
        })),
        { id: "a:csettings", label: "Cluster settings", hint: "settings", run: () => setPage({ kind: "cluster", id: activeId! }) },
        { id: "a:disconnect", label: "Disconnect from cluster", hint: "action", run: disconnect },
      );
    }
    list.push(
      ...contexts.contexts.map((c) => ({
        id: `c:${c.id}`,
        label: clusterName(c, prefs.clusters[c.id]),
        hint: "cluster",
        run: () => connect(c),
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
  }, [conn, namespaceNames, contexts, navigate, connect, disconnect, prefs.clusters, activeId]);

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
      } else if (mod && e.key.toLowerCase() === "n" && conn) {
        e.preventDefault();
        openCreate();
      } else if (mod && e.key === "`" && conn) {
        e.preventDefault();
        openTerminal();
      } else if (mod && e.key === "[") {
        e.preventDefault();
        go(-1);
      } else if (mod && e.key === "]") {
        e.preventDefault();
        go(1);
      } else if (mod && e.key.toLowerCase() === "w" && view && !(e.target as HTMLElement).closest(".dock")) {
        e.preventDefault();
        closeMainTab(view);
      } else if (e.key === "Escape" && !palette) {
        select(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const activeCtx = contexts.contexts.find((c) => c.id === activeId);
  const settingsCtx = page?.kind === "cluster" ? contexts.contexts.find((c) => c.id === page.id) : undefined;
  const h = history.current;
  const shownTabs = (conn ? mainTabs : [CATALOG]).map((id) => ({
    id,
    title: id === CATALOG ? "Catalog" : viewTitle(id, conn?.resources ?? []),
  }));
  const current = conn ? view : CATALOG;

  return (
    <NamespaceContext.Provider value={{ value: namespace, names: namespaceNames, set: pickNamespace }}>
      <div className="app">
        <TitleBar
          canBack={h.index > 0}
          canForward={h.index < h.entries.length - 1}
          onBack={() => go(-1)}
          onForward={() => go(1)}
          onSearch={() => setPalette(true)}
          onCreate={conn ? openCreate : undefined}
          onTerminal={conn ? openTerminal : undefined}
        />
        <div className="workspace">
          <Hotbar
            contexts={contexts.contexts}
            active={activeId}
            connecting={connecting}
            onPick={connect}
            onClusterMenu={openClusterMenu}
            onHome={() => {
              setPage(null);
              navigate(CATALOG);
            }}
            onPreferences={() => setPage({ kind: "prefs" })}
          />
          <Navigator
            contexts={contexts.contexts}
            activeId={activeId}
            connecting={connecting}
            connection={conn}
            current={current}
            onConnect={connect}
            onSettings={(c) => setPage({ kind: "cluster", id: c.id })}
            onClusterMenu={openClusterMenu}
            onPick={(id) => navigate(id)}
            onHome={() => navigate(CATALOG)}
            onSearch={() => setPalette(true)}
          />
          <div className="main">
            <MainTabs
              tabs={shownTabs}
              active={current}
              suffix={conn && activeCtx ? clusterName(activeCtx, clusterPrefs) : undefined}
              accent={activeCtx ? clusterColor(activeCtx, clusterPrefs) : undefined}
              onActivate={(id) => navigate(id)}
              onClose={conn ? closeMainTab : undefined}
              onCloseMany={conn ? closeMainTabs : undefined}
            />
            <div className="main-body">
            <div className="main-left">
            <div className="content">
              {current === CATALOG && (
                <Catalog
                  catalog={contexts}
                  connecting={connecting}
                  activeId={activeId}
                  error={error}
                  onPick={(c) => (c.id === activeId ? navigate(OVERVIEW) : connect(c))}
                  onSettings={(c) => setPage({ kind: "cluster", id: c.id })}
                  onChanged={refreshContexts}
                  notify={notify}
                />
              )}
              {conn && !current && <div className="empty-view muted">Open something from the Navigator.</div>}
              {conn && (
                <>
                  {view === OVERVIEW && <Overview conn={conn} namespace={nsParam} nodeMetrics={nodeMetrics} onOpen={navigate} />}
                  {view === PORT_FORWARDS && <PortForwards />}
                  {view === HELM && <HelmReleases namespace={nsParam} notify={notify} />}
                  {view === FLUX && <FluxDashboard conn={conn} namespace={nsParam} onNavigate={navigate} notify={notify} />}
                  {view === ARGO && <ArgoDashboard conn={conn} namespace={nsParam} onNavigate={navigate} notify={notify} />}
                  {view === COST && activeId && (
                    <CostDashboard
                      conn={conn}
                      clusterId={activeId}
                      prefs={clusterPrefs ?? {}}
                      onNavigate={navigate}
                      onOpenSettings={(section) => setPage({ kind: "cluster", id: activeId, section })}
                    />
                  )}
                  {view && !resource && !(view in SPECIAL_VIEWS) && view !== CATALOG && (
                    <div className="empty-view muted">This resource is not available in the cluster.</div>
                  )}
                  {resource && (
                    <ResourceTable
                      key={resource.key}
                      resource={resource}
                      watch={watch}
                      allNamespaces={!nsParam}
                      metrics={view === "/pods" ? podMetrics : view === "/nodes" ? nodeMetrics : null}
                      extraColumns={sliceColumns}
                      selectedUid={selected}
                      onSelect={(o) => select(o.metadata.uid)}
                      notify={notify}
                      actions={actions}
                    />
                  )}
                </>
              )}
            </div>
            {conn && (
              <Dock tabs={tabs} active={activeTab} onActivate={setActiveTab} onClose={closeTab} onCloseMany={closeTabs} onNewTerminal={openTerminal} />
            )}
            </div>
            {/* The details drawer spans the full height next to the list and the dock. */}
            {conn && resource && selectedObj && (
              <DetailsPanel
                key={selected}
                resource={resource}
                resources={conn.resources}
                obj={selectedObj}
                onClose={() => select(undefined)}
                onNavigate={navigate}
                notify={notify}
                {...actions}
              />
            )}
            </div>
          </div>
        </div>
        <StatusBar
          ctx={activeCtx}
          prefs={clusterPrefs}
          conn={conn}
          namespace={nsParam}
          onForwards={() => navigate(PORT_FORWARDS)}
        />
        {page?.kind === "prefs" && (
          <Preferences catalog={contexts} onClose={() => setPage(null)} onChanged={refreshContexts} notify={notify} />
        )}
        {settingsCtx && (
          <ClusterSettings
            key={settingsCtx.id}
            ctx={settingsCtx}
            connected={settingsCtx.id === activeId}
            initial={page?.kind === "cluster" ? page.section : undefined}
            onClose={() => setPage(null)}
            onReconnect={() => {
              setPage(null);
              connect(settingsCtx);
            }}
            onRemoved={() => {
              setPage(null);
              if (settingsCtx.id === activeId) disconnect();
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
                active: clusterMenu.ctx.id === activeId,
                connecting: clusterMenu.ctx.id === connecting,
                prefs: prefs.clusters[clusterMenu.ctx.id],
              },
              {
                connect: (c) => {
                  setPage(null);
                  connect(c);
                },
                disconnect,
                settings: (c) => setPage({ kind: "cluster", id: c.id }),
                terminal: openTerminal,
                setHotbar: (c, shown) =>
                  saveClusterPrefs(c.id, { hideFromHotbar: !shown }).catch((e) => notify(String(e), "bad")),
                copy: (text) => navigator.clipboard.writeText(text).then(() => notify(`Copied ${text}`)),
                reveal: (path) => api.reveal(path).catch((e) => notify(String(e), "bad")),
                remove: async (c) => {
                  if (!confirm(`Remove context "${c.name}" from ${c.file}?\n\nA backup is kept as ${c.file}.bens-backup.`)) return;
                  try {
                    await api.deleteContext(c.file, c.name);
                    notify(`Removed ${c.name}`);
                    if (c.id === activeId) disconnect();
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
    </NamespaceContext.Provider>
  );
}
