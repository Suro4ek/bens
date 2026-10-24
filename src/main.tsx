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

// Text fields hold names, filters and values, not prose: no spell checking, autocorrection or
// capitalization (macOS offered "Rpd" for "rpd" in a search box). A field can still opt in with its own attribute.
document.addEventListener(
  "focusin",
  (e) => {
    const field = e.target as HTMLElement;
    if (!field.matches?.("textarea, input:not([type=checkbox]):not([type=radio])")) return;
    for (const [name, value] of [["spellcheck", "false"], ["autocorrect", "off"], ["autocapitalize", "off"], ["autocomplete", "off"]])
      if (!field.hasAttribute(name)) field.setAttribute(name, value);
  },
  true,
);

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
