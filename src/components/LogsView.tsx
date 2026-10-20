import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, CaseSensitive, Check, ChevronDown, Clock, Copy, History, Regex, Search, Tag, WrapText, X } from "lucide-react";
import { api, KubeObject, ResourceInfo } from "../api";
import { containerBrick } from "../columns";
import { useAppPrefs } from "../prefs";
import { useWatch } from "../useWatch";

const MAX_LINES = 20_000;
const PODS_KEY = "/v1/pods";
/** "All" in the pod and container pickers. */
export const ALL = "*";

/** What a logs tab shows: one pod, or the pods of a workload (Deployment, StatefulSet, Job…). */
export type LogsSource = { pod: KubeObject } | { workload: { resource: ResourceInfo; obj: KubeObject } };

interface Line {
  /** Milliseconds since the epoch, from the API server's timestamp; lines of all streams are merged by it. */
  t: number;
  ts: string;
  text: string;
  /** Index of the stream (pod/container) in `streams`. */
  s: number;
}

interface Stream {
  pod: string;
  container: string;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/** Stable color per stream name, for the `[pod/container]` prefixes. */
const PREFIX_COLORS = ["#4fb3d9", "#e5a03c", "#7cc66f", "#d97ec4", "#a48ff0", "#e57373", "#4db6ac", "#c0ca33"];
const colorOf = (name: string) => PREFIX_COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PREFIX_COLORS.length];

const containersOf = (pod: KubeObject) => ({
  init: ((pod.spec?.initContainers ?? []) as any[]).map((c) => c.name as string),
  main: ((pod.spec?.containers ?? []) as any[]).map((c) => c.name as string),
});

/** A container ran before and was terminated: there are "previous" logs to read. */
const hasPrevious = (pod: KubeObject, container: string) =>
  [...((pod.status?.initContainerStatuses ?? []) as any[]), ...((pod.status?.containerStatuses ?? []) as any[])].some(
    (s) => s.name === container && s.lastState?.terminated,
  );

/** Label selector of a workload's pods. */
function selectorOf(obj: KubeObject): string | undefined {
  const labels = obj.spec?.selector?.matchLabels ?? (obj.kind === "ReplicationController" ? obj.spec?.selector : undefined);
  const parts = Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of (obj.spec?.selector?.matchExpressions ?? []) as any[]) {
    if (e.operator === "In") parts.push(`${e.key} in (${e.values.join(",")})`);
    else if (e.operator === "NotIn") parts.push(`${e.key} notin (${e.values.join(",")})`);
    else if (e.operator === "Exists") parts.push(e.key);
    else if (e.operator === "DoesNotExist") parts.push(`!${e.key}`);
  }
  return parts.length ? parts.join(",") : undefined;
}

interface Option {
  value: string;
  label: string;
  hint?: React.ReactNode;
}

/** Toolbar multi-select: a pinned "All" option, then groups of options with checkboxes. */
function MultiSelect({
  allLabel,
  groups,
  value,
  onChange,
  placeholder,
}: {
  allLabel: string;
  groups: { label?: string; options: Option[] }[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const all = groups.flatMap((g) => g.options.map((o) => o.value));
  const isAll = value.includes(ALL) || (all.length > 0 && all.every((v) => value.includes(v)));
  const selected = isAll ? all : value.filter((v) => all.includes(v));
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    onChange(next.length === all.length ? [ALL] : next);
  };
  const label = isAll ? allLabel : selected.length === 0 ? placeholder : selected.length === 1 ? selected[0] : `${selected.length} selected`;
  return (
    <div className="msel">
      <button className={`msel-btn ${selected.length === 0 ? "muted" : ""}`} onClick={() => setOpen((o) => !o)} title={selected.join("\n")}>
        <span className="ellipsis">{label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu msel-menu">
            <div className="menu-item" onClick={() => onChange(isAll ? [] : [ALL])}>
              <span className="msel-check">{isAll && <Check size={13} />}</span>
              <b>{allLabel}</b>
            </div>
            {groups.map((g) => (
              <div key={g.label ?? "_"}>
                {g.label && <div className="msel-group">{g.label}</div>}
                {g.options.map((o) => (
                  <div key={o.value} className="menu-item" onClick={() => toggle(o.value)}>
                    <span className="msel-check">{selected.includes(o.value) && <Check size={13} />}</span>
                    {o.hint}
                    <span className="ellipsis">{o.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const ContainerDot = ({ pod, name }: { pod: KubeObject; name: string }) => {
  const b = containerBrick(pod, name);
  return <span className={`brick ${b.tone}`} title={b.text} />;
};

export function LogsView({ source, initialContainer }: { source: LogsSource; initialContainer?: string }) {
  const single = "pod" in source ? source.pod : undefined;
  const workload = "workload" in source ? source.workload.obj : undefined;
  const namespace = (single ?? workload)!.metadata.namespace!;

  // Pods are watched so new replicas, restarts and container states show up.
  const selector = workload && selectorOf(workload);
  const watch = useWatch(
    single || selector ? PODS_KEY : undefined,
    namespace,
    single ? { fieldSelector: `metadata.name=${single.metadata.name}` } : { labelSelector: selector },
  );
  const pods = useMemo(() => {
    const live = watch.items.length ? watch.items : single ? [single] : [];
    return [...live].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }, [watch.items, single]);

  const [podSel, setPodSel] = useState<string[]>([ALL]);
  const [containerSel, setContainerSel] = useState<string[]>([initialContainer ?? ALL]);
  const [previous, setPrevious] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [names, setNames] = useState<boolean | null>(null);
  const [filter, setFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [follow, setFollow] = useState(true);
  const tailLines = useAppPrefs().logTailLines;
  const box = useRef<HTMLPreElement>(null);

  const selectedPods = pods.filter((p) => podSel.includes(ALL) || podSel.includes(p.metadata.name));
  // Containers are picked for one pod at a time; several pods show all their containers.
  const onePod = selectedPods.length === 1 ? selectedPods[0] : undefined;
  const streams: Stream[] = selectedPods.flatMap((p) => {
    const { init, main } = containersOf(p);
    return [...init, ...main]
      .filter((c) => !onePod || containerSel.includes(ALL) || containerSel.includes(c))
      .filter((c) => !previous || hasPrevious(p, c))
      .map((container) => ({ pod: p.metadata.name, container }));
  });
  // Streams restart only when what is streamed changes, not on every pod status update.
  const streamKey = streams.map((s) => `${s.pod}/${s.container}`).join("|");

  const [lines, setLines] = useState<Line[]>([]);
  const [states, setStates] = useState<Record<number, string>>({});

  useEffect(() => {
    setLines([]);
    setStates({});
    if (!streams.length) return;
    const pending: Line[] = [];
    let frame = 0;
    // Batches from all streams are merged once per frame, in timestamp order.
    const flush = () => {
      frame = 0;
      const batch = pending.splice(0);
      setLines((old) => {
        const sorted = old.length && batch.length && batch[0].t < old[old.length - 1].t;
        let next = old.concat(batch);
        if (sorted || streams.length > 1) next = next.sort((a, b) => a.t - b.t);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    const stops = streams.map((st, s) =>
      api.logs(
        { namespace, pod: st.pod, container: st.container, tailLines, previous, timestamps: true },
        (e) => {
          if (e.type === "lines") {
            for (const raw of e.lines) {
              const sp = raw.indexOf(" ");
              const ts = sp > 0 ? raw.slice(0, sp) : "";
              const t = Date.parse(ts);
              pending.push(Number.isNaN(t) ? { t: pending.at(-1)?.t ?? 0, ts: "", text: raw, s } : { t, ts, text: raw.slice(sp + 1), s });
            }
            frame ||= requestAnimationFrame(flush);
            setStates((x) => (x[s] === "streaming" ? x : { ...x, [s]: "streaming" }));
          } else if (e.type === "end") setStates((x) => ({ ...x, [s]: "ended" }));
          else setStates((x) => ({ ...x, [s]: `error: ${e.message}` }));
        },
      ),
    );
    return () => {
      cancelAnimationFrame(frame);
      stops.forEach((stop) => stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, streamKey, previous, tailLines]);

  const showNames = names ?? streams.length > 1;

  const matcher = useMemo(() => {
    const q = filter;
    if (!q) return null;
    try {
      return new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
    } catch {
      return undefined;
    }
  }, [filter, regex, caseSensitive]);

  const shown = useMemo(() => (matcher ? lines.filter((l) => l.text.search(matcher) >= 0) : lines), [lines, matcher]);

  const html = useMemo(() => {
    const fmtTs = (l: Line) => {
      if (!l.ts) return "";
      const d = new Date(l.t);
      const p = (n: number, w = 2) => String(n).padStart(w, "0");
      return `<span class="log-ts">${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}</span> `;
    };
    const prefixes = streams.map((st) => {
      const name = selectedPods.length > 1 ? `${st.pod}/${st.container}` : st.container;
      return `<span class="log-src" style="color:${colorOf(name)}">[${esc(name)}]</span> `;
    });
    return shown
      .map((l) => {
        const text = matcher ? highlight(l.text, matcher) : esc(l.text);
        return (timestamps ? fmtTs(l) : "") + (showNames ? (prefixes[l.s] ?? "") : "") + text;
      })
      .join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, timestamps, showNames, streamKey, matcher]);

  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [html, follow]);

  const counts = Object.values(states);
  const errors = Object.entries(states).filter(([, v]) => v.startsWith("error"));
  const status = !streams.length
    ? previous
      ? "no previous terminated containers"
      : watch.loading
        ? "looking for pods…"
        : "nothing selected"
    : errors.length
      ? `${errors.length} of ${streams.length} stream(s) failed`
      : counts.length < streams.length
        ? "connecting…"
        : counts.every((s) => s === "ended")
          ? previous
            ? "previous containers"
            : "stream ended"
          : `streaming${streams.length > 1 ? ` ${streams.length} containers` : ""}`;
  const errorText = errors.map(([s, v]) => `${streams[+s]?.pod}/${streams[+s]?.container}: ${v.slice(7)}`).join("\n");

  const containerGroups: { label?: string; options: Option[] }[] = [];
  if (onePod) {
    const { init, main } = containersOf(onePod);
    const opt = (c: string): Option => ({ value: c, label: c, hint: <ContainerDot pod={onePod} name={c} /> });
    containerGroups.push({ label: init.length ? "Containers" : undefined, options: main.map(opt) });
    if (init.length) containerGroups.push({ label: "Init Containers", options: init.map(opt) });
  }

  return (
    <div className="logs">
      <div className="dock-toolbar logs-toolbar">
        {workload && (
          <MultiSelect
            allLabel="All Pods"
            placeholder="Select Pods"
            value={podSel}
            onChange={(v) => {
              setPodSel(v);
              setContainerSel([ALL]);
            }}
            groups={[
              {
                options: pods.map((p) => ({
                  value: p.metadata.name,
                  label: p.metadata.name,
                  hint: <span className={`brick ${p.status?.phase === "Running" ? "ok" : p.status?.phase === "Succeeded" ? "done" : "warn"}`} />,
                })),
              },
            ]}
          />
        )}
        {onePod ? (
          <MultiSelect allLabel="All Containers" placeholder="Select Containers" value={containerSel} onChange={setContainerSel} groups={containerGroups} />
        ) : (
          selectedPods.length > 1 && <span className="muted small">all containers</span>
        )}
        <div className={`search-box logs-search ${matcher === undefined ? "invalid" : ""}`}>
          <button className={`search-toggle ${caseSensitive ? "on" : ""}`} onClick={() => setCaseSensitive((v) => !v)} title="Match case">
            <CaseSensitive size={16} />
          </button>
          <button className={`search-toggle ${regex ? "on" : ""}`} onClick={() => setRegex((v) => !v)} title="Use regular expression">
            <Regex size={14} />
          </button>
          <Search size={13} className="muted" />
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && (
            <button className="icon" onClick={() => setFilter("")} title="Clear">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="logs-toggles">
          <button className={`search-toggle ${timestamps ? "on" : ""}`} onClick={() => setTimestamps((v) => !v)} title="Show timestamps">
            <Clock size={15} />
          </button>
          <button className={`search-toggle ${showNames ? "on" : ""}`} onClick={() => setNames(!showNames)} title="Show resource names">
            <Tag size={15} />
          </button>
          <button className={`search-toggle ${previous ? "on" : ""}`} onClick={() => setPrevious((v) => !v)} title="Show previous terminated containers">
            <History size={15} />
          </button>
          <button className={`search-toggle ${wrap ? "on" : ""}`} onClick={() => setWrap((v) => !v)} title="Wrap lines">
            <WrapText size={15} />
          </button>
          <button
            className="search-toggle"
            title="Copy shown lines"
            onClick={() => navigator.clipboard.writeText(box.current?.innerText ?? "")}
          >
            <Copy size={15} />
          </button>
        </div>
        <div className="spacer" />
        <span className={`small ${errors.length ? "status bad" : "muted"}`} title={errorText || undefined}>
          {shown.length}
          {matcher ? ` of ${lines.length}` : ""} lines · {status}
        </span>
      </div>
      <div className="log-wrap">
        <pre
          ref={box}
          className={`log-box ${wrap ? "" : "nowrap"}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {!follow && (
          <button className="log-jump" onClick={() => setFollow(true)} title="Jump to the latest lines">
            <ArrowDownToLine size={14} /> Latest
          </button>
        )}
      </div>
    </div>
  );
}

function highlight(text: string, re: RegExp): string {
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}
