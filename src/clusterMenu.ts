import { Copy, FolderOpen, Pin, PinOff, Plug, RefreshCw, Settings, SquareTerminal, Trash2, Unplug } from "lucide-react";
import type { ContextInfo } from "./api";
import type { MenuItem } from "./components/ObjectMenu";
import type { ClusterPrefs } from "./prefs";

export interface ClusterMenuActions {
  connect: (ctx: ContextInfo) => void;
  disconnect: (ctx: ContextInfo) => void;
  settings: (ctx: ContextInfo) => void;
  terminal: (ctx: ContextInfo) => void;
  setHotbar: (ctx: ContextInfo, shown: boolean) => void;
  copy: (text: string) => void;
  reveal: (path: string) => void;
  remove: (ctx: ContextInfo) => void;
}

/** Right-click menu of a cluster in the Navigator and the hotbar. `active` means connected. */
export function clusterMenuItems(
  ctx: ContextInfo,
  state: { active: boolean; connecting: boolean; prefs?: ClusterPrefs },
  a: ClusterMenuActions,
): MenuItem[] {
  const { active, connecting, prefs } = state;
  return [
    ...(active
      ? [
          { label: "Reconnect", icon: RefreshCw, run: () => a.connect(ctx) },
          { label: "Disconnect", icon: Unplug, run: () => a.disconnect(ctx) },
          { label: "Open terminal", icon: SquareTerminal, run: () => a.terminal(ctx) },
        ]
      : [{ label: connecting ? "Connecting…" : "Connect", icon: Plug, run: () => !connecting && a.connect(ctx) }]),
    { label: "Settings", icon: Settings, run: () => a.settings(ctx) },
    prefs?.hideFromHotbar
      ? { label: "Add to hotbar", icon: Pin, run: () => a.setHotbar(ctx, true) }
      : { label: "Remove from hotbar", icon: PinOff, run: () => a.setHotbar(ctx, false) },
    { label: "Copy context name", icon: Copy, run: () => a.copy(ctx.name) },
    ...(ctx.pasted ? [] : [{ label: "Show kubeconfig in folder", icon: FolderOpen, run: () => a.reveal(ctx.file) }]),
    { label: "Remove from kubeconfig", icon: Trash2, danger: true, run: () => a.remove(ctx) },
  ];
}
