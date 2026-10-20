import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { loadPrefs } from "./prefs";

// No browser context menu (Reload, Inspect…) — it breaks the app's state. It stays where it is useful:
// in text fields and over selected text (Cut / Copy / Paste).
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  const editable = target?.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .cm-editor");
  const selected = !!window.getSelection()?.toString();
  if (!editable && !selected) e.preventDefault();
});

// Preferences (theme, start-up behavior) are needed before the first render.
loadPrefs()
  .catch((e) => console.error("preferences:", e))
  .finally(() =>
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  );
