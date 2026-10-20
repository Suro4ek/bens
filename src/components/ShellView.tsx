import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, ExecEvent, KubeObject, newId } from "../api";
import { AppPrefs, getAppPrefs, isDark, MONO_FONT, useAppPrefs } from "../prefs";

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** FitAddon throws while the terminal isn't rendered yet (hidden tab, first frame). */
const safeFit = (fit?: FitAddon | null) => {
  try {
    fit?.fit();
  } catch {
    /* not laid out yet */
  }
};

const termOptions = (p: AppPrefs) => ({
  fontFamily: p.terminalFontFamily ? `"${p.terminalFontFamily}", ${MONO_FONT}` : MONO_FONT,
  fontSize: p.terminalFontSize,
  theme: isDark()
    ? { background: "#000000", foreground: "#ffffff", cursor: "#ffffff", selectionBackground: "#ffffff55" }
    : {
        background: "#ffffff",
        foreground: "#1f2328",
        cursor: "#1f2328",
        selectionBackground: "#b6d6f5",
        black: "#1f2328",
        white: "#6e7781",
        brightWhite: "#8c959f",
        yellow: "#9a6700",
        brightYellow: "#7d4e00",
      },
});

interface Props {
  /** Pod to exec into; without it (and without `node`) a local shell bound to the cluster is opened. */
  pod?: KubeObject;
  /** Node to open a root shell on (via a privileged helper pod). */
  node?: string;
  container?: string;
  active: boolean;
}

export function ShellView({ pod, node, container, active }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>(null);
  const termRef = useRef<Terminal>(null);
  const prefs = useAppPrefs();

  useEffect(() => {
    const term = new Terminal({ ...termOptions(getAppPrefs()), cursorBlink: true });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host.current!);
    safeFit(fit);

    const sessionId = newId("exec");
    let closed = false;
    let disposed = false;
    const onEvent = (e: ExecEvent) => {
      if (disposed) return;
      if (e.type === "data") term.write(decode(e.data));
      else {
        closed = true;
        term.writeln("\r\n\x1b[2m[session closed]\x1b[0m");
      }
    };
    const size = { cols: term.cols, rows: term.rows };
    let started: Promise<void>;
    if (pod) {
      term.writeln(`\x1b[2mConnecting to ${pod.metadata.name}${container ? `/${container}` : ""}…\x1b[0m`);
      started = api.execStart(
        sessionId,
        { namespace: pod.metadata.namespace!, pod: pod.metadata.name, container, ...size },
        onEvent,
      );
    } else if (node) {
      term.writeln(`\x1b[2mStarting node shell pod on ${node} (this can take a moment)…\x1b[0m`);
      started = api.nodeShellStart(sessionId, { node, ...size }, onEvent);
    } else {
      started = api.localTerminalStart(sessionId, size, onEvent);
    }
    started
      .then(() => {
        if (disposed) api.execStop(sessionId);
      })
      .catch((e) => {
        closed = true;
        if (!disposed) term.writeln(`\r\n\x1b[31m${e}\x1b[0m`);
      });

    const input = term.onData((d) => !closed && api.execInput(sessionId, d));
    const resize = term.onResize(({ cols, rows }) => !closed && api.execResize(sessionId, cols, rows));
    // Copy on select (when enabled in Preferences).
    const selection = term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text && getAppPrefs().terminalCopyOnSelect) navigator.clipboard.writeText(text).catch(() => {});
    });
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) safeFit(fit);
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      ro.disconnect();
      input.dispose();
      selection.dispose();
      resize.dispose();
      api.execStop(sessionId);
      // xterm schedules a viewport sync right after open(); disposing first makes it throw.
      setTimeout(() => term.dispose(), 0);
    };
  }, [pod?.metadata.namespace, pod?.metadata.name, node, container]);

  // Apply font/theme changes from Preferences to the open terminal.
  const appliedPrefs = useRef(prefs);
  useEffect(() => {
    const term = termRef.current;
    // The terminal is created with the current prefs; only re-apply real changes.
    if (!term || appliedPrefs.current === prefs) return;
    appliedPrefs.current = prefs;
    try {
      Object.assign(term.options, termOptions(prefs));
    } catch {
      /* renderer not ready */
    }
    requestAnimationFrame(() => safeFit(fitRef.current));
  }, [prefs]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => safeFit(fitRef.current));
  }, [active]);

  return <div className="terminal" ref={host} />;
}
