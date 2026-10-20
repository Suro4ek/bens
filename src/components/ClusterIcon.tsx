import type { ContextInfo } from "../api";
import { clusterColor, clusterIcon, ClusterPrefs } from "../prefs";

/** Cluster avatar: uploaded picture, or text on a colored square. */
export function ClusterIcon({ ctx, prefs, className = "card-icon" }: { ctx: ContextInfo; prefs?: ClusterPrefs; className?: string }) {
  if (prefs?.iconImage) {
    return <img className={`${className} icon-img`} src={prefs.iconImage} alt="" draggable={false} />;
  }
  return (
    <div className={className} style={{ background: clusterColor(ctx, prefs) }}>
      {clusterIcon(ctx, prefs)}
    </div>
  );
}
