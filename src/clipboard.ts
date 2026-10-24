//! Copying text, and telling a click apart from selecting text with the mouse.

type Notify = (msg: string, tone?: "ok" | "bad") => void;

/** Copies text and says so ("Copied message"). */
export function copyText(text: string, notify?: Notify, what = "to clipboard") {
  return navigator.clipboard.writeText(text).then(
    () => notify?.(`Copied ${what}`),
    (e) => notify?.(String(e), "bad"),
  );
}

/** Text the user has selected, if the selection is inside `el` (or anywhere, without one). */
export function selectedText(el?: Element | null): string {
  const sel = window.getSelection();
  const text = sel?.toString() ?? "";
  if (!text || !el || !sel?.anchorNode) return text;
  return el.contains(sel.anchorNode) ? text : "";
}

/** A row click that doesn't fire when the mouse was used to select text in the row. */
export const unlessSelecting =
  <E extends { currentTarget: Element }>(fn: (e: E) => void) =>
  (e: E) => {
    if (!selectedText(e.currentTarget)) fn(e);
  };

/** One line per event: what kubectl get events shows. */
export function eventText(e: { type?: string; reason?: string; message?: string; involvedObject?: any; metadata: { namespace?: string } }) {
  const o = e.involvedObject ?? {};
  const ns = o.namespace ?? e.metadata.namespace;
  return `${e.type ?? ""} ${e.reason ?? ""} ${o.kind ?? ""}/${ns ? `${ns}/` : ""}${o.name ?? ""}: ${e.message ?? ""}`.trim();
}
