import { useEffect, useState } from "react";
import type { PullProgress } from "../api";
import { useApi } from "../clusterContext";
import { duration, PullSpeeds } from "../pulls";
import { formatBytes } from "../util";

export interface PullState {
  progress?: PullProgress;
  error?: string;
  /** Bytes per second by manifest. */
  speeds: Record<string, number>;
  /** Something was downloading earlier and nothing is now: the runtime is unpacking. */
  downloaded: boolean;
}

/**
 * Reads the node's image downloads every two seconds while `run` is set (each new value
 * starts over after an error). Stopping removes the helper from the node.
 */
export function usePullProgress(node: string | undefined, run: number): PullState {
  const api = useApi();
  const [state, setState] = useState<PullState>({ speeds: {}, downloaded: false });
  useEffect(() => {
    if (!node || !run) return;
    let live = true;
    let timer = 0;
    let seen = false;
    const speeds = new PullSpeeds();
    const read = async () => {
      try {
        const progress = await api.imagePullProgress(node);
        if (!live) return;
        seen ||= progress.pulls.length > 0;
        setState({ progress, speeds: speeds.update(progress.pulls, Date.now()), downloaded: seen && !progress.pulls.length });
        timer = window.setTimeout(read, 2000);
      } catch (e) {
        if (live) setState((s) => ({ ...s, error: String(e) }));
      }
    };
    setState({ speeds: {}, downloaded: false });
    read();
    return () => {
      live = false;
      clearTimeout(timer);
      api.imagePullProgressStop(node).catch(() => {});
    };
  }, [api, node, run]);
  return state;
}

/** Re-renders every second. */
function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const bytes = (n: number) => {
  const s = formatBytes(n);
  return s.endsWith("i") ? `${s}B` : s;
};

/** A container whose image is being pulled: for how long and, once asked for, how far along the node is. */
export function PullStatus({ since, node, pull, running, onStart }: { since: string; node?: string; pull: PullState; running: boolean; onStart: () => void }) {
  const now = useClock();
  const { progress, error, speeds, downloaded } = pull;
  const elapsed = duration((now - Date.parse(since)) / 1000);

  let detail: React.ReactNode = null;
  if (!running) {
    detail = node && (
      <button className="link-button" title="Starts a small pod on the node that reads containerd's downloads, with an image the node already has; it is removed when you leave" onClick={onStart}>
        Show progress
      </button>
    );
  } else if (error) {
    detail = (
      <>
        <span className="env-problem small">{error}</span>{" "}
        <button className="link-button" onClick={onStart}>
          Retry
        </button>
      </>
    );
  } else if (!progress) {
    detail = <span className="muted small">Reading the node…</span>;
  } else if (progress.starting) {
    detail = <span className="muted small">{progress.starting}</span>;
  } else if (progress.unsupported) {
    detail = <span className="muted small">No containerd content store on the node: progress isn't available.</span>;
  } else if (!progress.pulls.length) {
    detail = (
      <span className="muted small">
        {downloaded
          ? "Downloaded, unpacking…"
          : progress.downloading
            ? "Fetching the image manifest…"
            : "Nothing is downloading yet: waiting for the registry or for other pulls on the node."}
      </span>
    );
  } else {
    detail = (
      <>
        {progress.pulls.length > 1 && <div className="muted small">{progress.pulls.length} images are being pulled on the node:</div>}
        {progress.pulls.map((p) => {
          const percent = p.total ? (p.done / p.total) * 100 : 0;
          const speed = speeds[p.manifest];
          const left = speed ? (p.total - p.done) / speed : undefined;
          return (
            <div key={p.manifest} className="pull" title={p.manifest}>
              <div className="pull-bar">
                <div style={{ width: `${percent}%` }} />
              </div>
              <span className="small">
                <b>{Math.floor(percent)}%</b> · {bytes(p.done)} of {bytes(p.total)}
                {speed !== undefined && ` · ${bytes(speed)}/s`}
                {left !== undefined && left < 360000 && ` · ${duration(left)} left`}
                <span className="muted"> · layers {p.layersDone}/{p.layers}</span>
              </span>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      <span className="status warn">Pulling image</span> <span className="muted small">for {elapsed}</span>
      {detail && <div className="pull-detail">{detail}</div>}
    </>
  );
}
