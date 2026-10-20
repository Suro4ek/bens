import { useEffect, useMemo, useState } from "react";
import { api, KubeObject, ResourceInfo } from "../api";
import { Column, columnsFor } from "../columns";
import type { WatchState } from "../useWatch";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { CaseSensitive, EllipsisVertical, FileDown, Regex, Search, Trash2, X } from "lucide-react";
import { NamespaceSelect } from "./NamespaceSelect";
import type { MetricsMap } from "../useMetrics";
import type { DockActions } from "./DetailsPanel";
import { ContextMenu, objectMenuItems, ScaleDialog } from "./ObjectMenu";

interface Props {
  resource: ResourceInfo;
  watch: WatchState;
  allNamespaces: boolean;
  metrics?: MetricsMap | null;
  /** Columns computed from other resources, shown before Age. */
  extraColumns?: Column[];
  selectedUid?: string;
  onSelect: (o: KubeObject) => void;
  notify: (msg: string, tone?: "ok" | "bad") => void;
  actions: DockActions;
}

const uidOf = (o: KubeObject) => o.metadata.uid ?? `${o.metadata.namespace}/${o.metadata.name}`;

export function ResourceTable({ resource, watch, allNamespaces, metrics, extraColumns, selectedUid, onSelect, notify, actions }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; obj: KubeObject } | null>(null);
  const [scaling, setScaling] = useState<KubeObject | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const columns = useMemo(
    () => columnsFor(resource, allNamespaces, metrics, extraColumns),
    [resource, allNamespaces, metrics, extraColumns],
  );
  const [filter, setFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>({ col: 0, dir: 1 });
  const [, setTick] = useState(0);

  // Re-render periodically so relative ages stay fresh.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // Search: plain text or regex, optionally case-sensitive; matches columns and labels.
  const matcher = useMemo(() => {
    const q = filter.trim();
    if (!q) return null;
    if (regex) {
      try {
        const re = new RegExp(q, caseSensitive ? "" : "i");
        return (text: string) => re.test(text);
      } catch {
        return () => false;
      }
    }
    const needle = caseSensitive ? q : q.toLowerCase();
    return (text: string) => (caseSensitive ? text : text.toLowerCase()).includes(needle);
  }, [filter, regex, caseSensitive]);
  const badRegex = useMemo(() => {
    if (!regex || !filter.trim()) return false;
    try {
      new RegExp(filter.trim());
      return false;
    } catch {
      return true;
    }
  }, [regex, filter]);

  const rows = useMemo(() => {
    const filtered = matcher
      ? watch.items.filter(
          (o) =>
            columns.some((c) => matcher(String(c.value(o)))) ||
            Object.entries(o.metadata.labels ?? {}).some(([k, v]) => matcher(`${k}=${v}`)),
        )
      : watch.items;
    const col = columns[sort.col] ?? columns[0];
    return [...filtered].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return cmp * sort.dir;
    });
  }, [watch.items, matcher, columns, sort]);

  const widths = ["32px", ...columns.map((c) => c.width ?? "minmax(100px, 1fr)"), "36px"];
  const template = widths.join(" ");
  // Wide lists (pods) scroll sideways, header and rows together, instead of losing the last columns.
  const minWidth = widths.reduce((sum, w) => sum + Number(/(\d+)px/.exec(w)?.[1] ?? 100), 0);

  // Forget checked rows that disappeared (deleted or filtered out).
  const visible = new Set(rows.map(uidOf));
  const checkedRows = rows.filter((o) => checked.has(uidOf(o)));
  const allChecked = rows.length > 0 && checkedRows.length === rows.length;
  const toggle = (o: KubeObject) =>
    setChecked((c) => {
      const next = new Set([...c].filter((u) => visible.has(u)));
      if (next.has(uidOf(o))) next.delete(uidOf(o));
      else next.add(uidOf(o));
      return next;
    });

  /** "Export list to CSV": the visible columns of the filtered, sorted rows. */
  const exportCsv = async () => {
    const path = await saveDialog({
      title: "Select export location",
      defaultPath: `bens-export-${resource.plural}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Age is exported as the timestamp, not as the sort key.
    const value = (c: Column, o: KubeObject) => (c.title === "Age" ? (o.metadata.creationTimestamp ?? "") : c.value(o));
    const csv = [columns.map((c) => cell(c.title)), ...rows.map((o) => columns.map((c) => cell(value(c, o))))]
      .map((r) => r.join(","))
      .join("\n");
    try {
      await api.saveTextFile(path, csv + "\n");
      notify(`Exported ${rows.length} item(s) to ${path}`);
    } catch (e) {
      notify(String(e), "bad");
    }
  };

  const deleteChecked = async () => {
    const names = checkedRows.map((o) => o.metadata.name);
    if (!confirm(`Delete ${names.length} ${resource.kind}(s)?\n\n${names.slice(0, 20).join("\n")}${names.length > 20 ? "\n…" : ""}`))
      return;
    const results = await Promise.allSettled(
      checkedRows.map((o) => api.delete(resource.key, o.metadata.namespace, o.metadata.name)),
    );
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    setChecked(new Set());
    notify(
      failed.length
        ? `Deleted ${results.length - failed.length}, failed ${failed.length}: ${failed[0].reason}`
        : `Deleted ${results.length}`,
      failed.length ? "bad" : "ok",
    );
  };

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        {resource.namespaced && <NamespaceSelect />}
        <div className={`search-box ${badRegex ? "invalid" : ""}`}>
          <button
            className={`search-toggle ${caseSensitive ? "on" : ""}`}
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match case"
          >
            <CaseSensitive size={16} />
          </button>
          <button className={`search-toggle ${regex ? "on" : ""}`} onClick={() => setRegex((v) => !v)} title="Use regular expression">
            <Regex size={14} />
          </button>
          <Search size={13} className="muted" />
          <input placeholder={`Search ${resource.kind}s…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && (
            <button className="icon" onClick={() => setFilter("")} title="Clear">
              <X size={13} />
            </button>
          )}
        </div>
        <button className="icon" onClick={exportCsv} disabled={!rows.length} title="Export list to CSV">
          <FileDown size={16} />
        </button>
        <span className="muted item-count">
          {rows.length} item{rows.length === 1 ? "" : "s"}
          {matcher && rows.length !== watch.items.length ? ` of ${watch.items.length}` : ""}
        </span>
        {checkedRows.length > 0 && (
          <>
            <span className="selection">{checkedRows.length} selected</span>
            <button className="icon" onClick={() => setChecked(new Set())} title="Clear selection">
              <X size={15} />
            </button>
            <button className="icon danger" onClick={deleteChecked} title="Delete selected">
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>
      {watch.error && <div className="banner bad">{watch.error}</div>}
      <div className="table" role="table">
        <div className="tr th" style={{ gridTemplateColumns: template, minWidth }}>
          <div className="td check">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map(uidOf)))}
            />
          </div>
          {columns.map((c, i) => (
            <div
              key={c.title}
              className="td"
              onClick={() => setSort((s) => ({ col: i, dir: s.col === i ? (-s.dir as 1 | -1) : 1 }))}
            >
              {c.title}
              {sort.col === i && <span className="sort">{sort.dir === 1 ? "▲" : "▼"}</span>}
            </div>
          ))}
          <div />
        </div>
        <div className="tbody" style={{ minWidth }}>
          {watch.loading && <div className="empty">Loading…</div>}
          {!watch.loading && rows.length === 0 && <div className="empty">No items</div>}
          {rows.map((o) => (
            <div
              key={uidOf(o)}
              className={`tr ${o.metadata.uid === selectedUid ? "selected" : ""} ${checked.has(uidOf(o)) ? "checked" : ""}`}
              style={{ gridTemplateColumns: template }}
              onClick={() => onSelect(o)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, obj: o });
              }}
            >
              <div className="td check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={checked.has(uidOf(o))} onChange={() => toggle(o)} />
              </div>
              {columns.map((c) => (
                <div key={c.title} className="td" title={String(c.value(o))}>
                  {c.render ? c.render(o) : c.value(o)}
                </div>
              ))}
              <div className="td row-menu">
                <button
                  className="icon"
                  title="Actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 2, obj: o });
                  }}
                >
                  <EllipsisVertical size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={objectMenuItems(menu.obj, { resource, actions, notify, askScale: setScaling })}
          onClose={() => setMenu(null)}
        />
      )}
      {scaling && <ScaleDialog resource={resource} obj={scaling} notify={notify} onClose={() => setScaling(null)} />}
    </div>
  );
}
