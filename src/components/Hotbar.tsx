import { House, Settings } from "lucide-react";
import type { ContextInfo } from "../api";
import { clusterColor, clusterIcon, clusterName, usePrefs } from "../prefs";

interface Props {
  contexts: ContextInfo[];
  active?: string;
  connecting?: string;
  onPick: (ctx: ContextInfo) => void;
  onSettings: (ctx: ContextInfo) => void;
  onHome: () => void;
  onPreferences: () => void;
}

const SLOTS = 12;

export function Hotbar({ contexts, active, connecting, onPick, onSettings, onHome, onPreferences }: Props) {
  const { clusters } = usePrefs();
  const shown = contexts.filter((c) => !clusters[c.id]?.hideFromHotbar || c.id === active);
  return (
    <nav className="hotbar">
      <button className="hot home" onClick={onHome} title="Catalog">
        <House size={18} />
      </button>
      {shown.map((c) => {
        const p = clusters[c.id];
        return (
          <button
            key={c.id}
            className={`hot ${p?.iconImage ? "img" : ""} ${c.id === active ? "active" : ""} ${c.id === connecting ? "pulse" : ""}`}
            style={p?.iconImage ? { backgroundImage: `url("${p.iconImage}")` } : { background: clusterColor(c, p) }}
            title={`${clusterName(c, p)}\n${c.server ?? ""}\n${c.file}\n\nRight-click for settings`}
            onClick={() => onPick(c)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSettings(c);
            }}
          >
            {!p?.iconImage && clusterIcon(c, p)}
          </button>
        );
      })}
      {/* Empty hotbar slots. */}
      {Array.from({ length: Math.max(0, SLOTS - shown.length) }, (_, i) => (
        <div key={i} className="hot slot" />
      ))}
      <div className="spacer" />
      <button className="hot home" onClick={onPreferences} title="Preferences (⌘,)">
        <Settings size={17} />
      </button>
    </nav>
  );
}
