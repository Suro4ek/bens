import type { ImagePull, KubeObject } from "./api";

/** Kubelet's events about a container's image; the latest says whether it is being pulled. */
const PULL_REASONS = new Set(["Pulling", "Pulled", "Failed", "BackOff", "ErrImageNeverPull", "InspectFailed"]);

const eventTime = (e: KubeObject): string | undefined => e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp;

/** Since when the container's image is being pulled, from the pod's events; undefined when it isn't. */
export function pullingSince(events: KubeObject[], container: string, init = false): string | undefined {
  const path = `spec.${init ? "initContainers" : "containers"}{${container}}`;
  let last: KubeObject | undefined;
  for (const e of events) {
    if (e.involvedObject?.fieldPath !== path || !PULL_REASONS.has(e.reason)) continue;
    const t = Date.parse(eventTime(e) ?? "");
    const lastT = last ? Date.parse(eventTime(last) ?? "") : -Infinity;
    // Events are stamped to the second: on a tie, the end of a pull comes after its start.
    if (t > lastT || (t === lastT && last?.reason === "Pulling")) last = e;
  }
  return last?.reason === "Pulling" ? eventTime(last) : undefined;
}

/** "1:05", "12:00:07". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** Download speeds in bytes per second by manifest, smoothed over readings. */
export class PullSpeeds {
  private last = new Map<string, { t: number; done: number; speed?: number }>();

  update(pulls: ImagePull[], now: number): Record<string, number> {
    const speeds: Record<string, number> = {};
    for (const p of pulls) {
      const prev = this.last.get(p.manifest);
      let speed = prev?.speed;
      if (prev && now > prev.t && p.done >= prev.done) {
        const current = ((p.done - prev.done) * 1000) / (now - prev.t);
        speed = speed === undefined ? current : speed * 0.6 + current * 0.4;
      }
      this.last.set(p.manifest, { t: now, done: p.done, speed });
      if (speed !== undefined) speeds[p.manifest] = speed;
    }
    return speeds;
  }
}
