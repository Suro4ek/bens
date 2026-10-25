import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { KubeObject, ResourceInfo } from "../api";
import { pluralTitle } from "../nav";

export interface AskOptions {
  title: string;
  /** What will happen, under the title. */
  message?: ReactNode;
  /** The confirming button's label. */
  ok?: string;
  cancel?: string;
  /** Destructive: a red button, and Cancel has the focus so that Enter doesn't confirm by accident. */
  danger?: boolean;
  /** Text to type before the button is enabled (a namespace's name…). */
  typeToConfirm?: string;
}

interface Question extends AskOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let queue: Question[] = [];
let lastId = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/**
 * Asks the user to confirm, in the app's own dialog. `window.confirm` mustn't be used: Tauri's
 * dialog plugin replaces it with an async function, and its Promise is always truthy, so
 * `if (!confirm(…)) return` let everything through.
 */
export function ask(options: AskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: ++lastId, resolve }];
    changed();
  });
}

function answer(ok: boolean) {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  changed();
  first.resolve(ok);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Shows the questions one at a time; mounted once at the root of the app. */
export function ConfirmHost() {
  const question = useSyncExternalStore(subscribe, () => queue[0]);
  // Nothing can answer once the host is gone: the questions left are declined.
  useEffect(
    () => () => {
      const left = queue;
      queue = [];
      changed();
      left.forEach((q) => q.resolve(false));
    },
    [],
  );
  return question ? <ConfirmDialog key={question.id} question={question} /> : null;
}

function ConfirmDialog({ question }: { question: Question }) {
  const { title, message, ok = "OK", cancel = "Cancel", danger, typeToConfirm } = question;
  const [typed, setTyped] = useState("");
  const ready = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <div className="modal-backdrop confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <form
        className="modal confirm-dialog"
        role="alertdialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Only the dialog closes, not the details panel or the modal under it.
          e.stopPropagation();
          answer(false);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) answer(true);
        }}
      >
        <h3>{title}</h3>
        {message && <div className="confirm-message">{message}</div>}
        {typeToConfirm && (
          <label className="field">
            <span>
              Type <b className="mono">{typeToConfirm}</b> to confirm
            </span>
            <input autoFocus className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="btn-row end">
          <button type="button" autoFocus={danger && !typeToConfirm} onClick={() => answer(false)}>
            {cancel}
          </button>
          <button type="submit" className={danger ? "danger" : "primary"} autoFocus={!danger && !typeToConfirm} disabled={!ready}>
            {ok}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Kinds whose deletion takes everything in them along: their name has to be typed. */
const CASCADING: Record<string, string> = {
  Namespace: "Everything in the namespace is deleted with it.",
  CustomResourceDefinition: "All its custom resources are deleted with it.",
};
const LISTED = 15;

/** Asks before deleting objects, saying which cluster and namespace they are in, so a wrong cluster stands out. */
export function askDelete(resource: ResourceInfo, objects: KubeObject[], cluster: string): Promise<boolean> {
  const [first] = objects;
  const single = objects.length === 1;
  const names = objects.map((o) => (o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name));
  const cascade = CASCADING[resource.kind];
  return ask({
    title: single ? `Delete ${resource.kind} ${first.metadata.name}?` : `Delete ${objects.length} ${pluralTitle(resource)}?`,
    message: (
      <>
        <p>
          {single && first.metadata.namespace && (
            <>
              In namespace <b>{first.metadata.namespace}</b>,{" "}
            </>
          )}
          {single && first.metadata.namespace ? "cluster" : "Cluster"} <b>{cluster}</b>
          {single ? "." : ":"}
        </p>
        {!single && (
          <ul className="confirm-list mono">
            {names.slice(0, LISTED).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {names.length > LISTED && <li className="muted">and {names.length - LISTED} more</li>}
          </ul>
        )}
        {cascade && <p className="status bad">{cascade}</p>}
      </>
    ),
    ok: "Delete",
    danger: true,
    typeToConfirm: cascade ? (single ? first.metadata.name : "delete") : undefined,
  });
}
