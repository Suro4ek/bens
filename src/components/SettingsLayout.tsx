import { ReactNode, useEffect, useState } from "react";

export interface SettingsSection {
  id: string;
  label: string;
  content: ReactNode;
}

interface Props {
  header: ReactNode;
  sections: SettingsSection[];
  initial?: string;
  onClose: () => void;
}

/** Full-page settings view with a section list on the left. */
export function SettingsLayout({ header, sections, initial, onClose }: Props) {
  const [active, setActive] = useState(initial ?? sections[0]?.id);
  const current = sections.find((s) => s.id === active) ?? sections[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest(".cm-editor")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-page">
      <nav className="settings-nav">
        {header}
        {sections.map((s) => (
          <div key={s.id} className={`nav-item ${s.id === current?.id ? "active" : ""}`} onClick={() => setActive(s.id)}>
            {s.label}
          </div>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-content">
          <h2>{current?.label}</h2>
          {current?.content}
        </div>
        <button className="settings-close" onClick={onClose} title="Close (Esc)">
          ✕<span className="small muted">ESC</span>
        </button>
      </div>
    </div>
  );
}

/** One setting: title, control, hint. */
export function Block({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting">
      <h4>{title}</h4>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </section>
  );
}

/** Text input that saves on blur or Enter (empty = unset), with a reset button. */
export function TextSetting({
  value,
  onSave,
  placeholder,
  mono,
}: {
  value: string | null | undefined;
  onSave: (v: string | null) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const commit = (v: string) => {
    const next = v.trim() || null;
    if (next !== (value || null)) onSave(next);
  };
  return (
    <div className="btn-row">
      <input
        className={`grow ${mono ? "mono" : ""}`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {draft && (
        <button
          className="icon"
          title="Reset"
          onClick={() => {
            setDraft("");
            commit("");
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function NumberSetting({
  value,
  onSave,
  min,
  max,
}: {
  value: number;
  onSave: (v: number) => void;
  min: number;
  max: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= min && n <= max) {
      if (n !== value) onSave(n);
    } else setDraft(String(value));
  };
  return (
    <input
      type="number"
      className="num"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Editable list of strings (add with Enter, remove with ✕). */
export function ListSetting({
  items,
  onSave,
  placeholder,
  validate,
}: {
  items: string[];
  onSave: (items: string[]) => void;
  placeholder: string;
  validate?: (v: string) => string | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string>();
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    const problem = validate?.(v);
    if (problem) return setErr(problem);
    setErr(undefined);
    setDraft("");
    if (!items.includes(v)) onSave([...items, v]);
  };
  return (
    <div className="list-setting">
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      {err && <div className="status bad small">{err}</div>}
      {items.map((i) => (
        <div key={i} className="list-item">
          <span className="mono">{i}</span>
          <button className="icon" onClick={() => onSave(items.filter((x) => x !== i))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
