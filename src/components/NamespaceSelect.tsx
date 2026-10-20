import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers, Search } from "lucide-react";

export const ALL_NAMESPACES = "__all__";

interface NamespaceState {
  value: string;
  names: string[];
  set: (ns: string) => void;
}

export const NamespaceContext = createContext<NamespaceState>({ value: ALL_NAMESPACES, names: [], set: () => {} });

/** Namespace filter at the left of list toolbars: a dropdown with a search box. */
export function NamespaceSelect({ disabled }: { disabled?: boolean }) {
  const { value, names, set } = useContext(NamespaceContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = [ALL_NAMESPACES, ...names.filter((n) => n.toLowerCase().includes(query.toLowerCase()))];

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(Math.max(0, shown.indexOf(value)));
      setTimeout(() => input.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (ns: string) => {
    set(ns);
    setOpen(false);
  };
  const label = (ns: string) => (ns === ALL_NAMESPACES ? "All namespaces" : ns);

  return (
    <div className={`ns-select ${disabled ? "disabled" : ""}`}>
      <button
        className="ns-select-btn"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? "Cluster-scoped resource" : "Namespace"}
      >
        <Layers size={14} className="muted" />
        <span className="ellipsis">{disabled ? "All namespaces" : label(value)}</span>
        <ChevronDown size={14} className="muted" />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu ns-menu">
            <div className="ns-search">
              <Search size={13} className="muted" />
              <input
                ref={input}
                placeholder="Search namespaces…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(e.target.value ? 1 : 0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, shown.length - 1));
                  else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
                  else if (e.key === "Enter" && shown[cursor]) pick(shown[cursor]);
                  else if (e.key === "Escape") setOpen(false);
                  else return;
                  e.preventDefault();
                }}
              />
            </div>
            <div className="ns-list">
              {shown.map((ns, i) => (
                <div
                  key={ns}
                  className={`menu-item ${i === cursor ? "active" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(ns)}
                >
                  <span className="msel-check">{ns === value && <Check size={13} />}</span>
                  <span className={`ellipsis ${ns === ALL_NAMESPACES ? "strong" : ""}`}>{label(ns)}</span>
                </div>
              ))}
              {shown.length === 1 && query && <div className="muted small ns-empty">No namespaces match</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
