import { describe, expect, it } from "vitest";
import type { KubeObject } from "./api";
import {
  DEFAULT_RATES,
  estimate,
  IDLE,
  isSpotNode,
  nodeRates,
  normalizeAllocation,
  normalizeClusterEfficiency,
  normalizeTrend,
  Observations,
  ratesFrom,
  segments,
  withoutIdle,
} from "./cost";

const GIB = 1024 ** 3;

describe("OpenCost / Kubecost responses", () => {
  const alloc = (cpu: number, ram: number, extra = {}) => ({ cpuCost: cpu, ramCost: ram, pvCost: 0, networkCost: 0, totalCost: cpu + ram, ...extra });

  it("normalizes per-namespace allocation, keeping idle in the total", () => {
    const res = {
      code: 200,
      data: [
        {
          web: alloc(3, 1, { cpuEfficiency: 0.5, ramEfficiency: 0.8, totalEfficiency: 0.6, cpuCoreRequestAverage: 1, ramByteRequestAverage: 1 }),
          batch: alloc(1, 1, { cpuEfficiency: 0, cpuCoreRequestAverage: 0, ramByteRequestAverage: 0 }),
          [IDLE]: alloc(3, 0),
        },
      ],
    };
    const a = normalizeAllocation(res, "7d");
    expect(a.totalCost).toBe(9);
    expect(a.namespaces.map((n) => n.namespace)).toEqual(["web", IDLE, "batch"]);
    expect(a.namespaces[0].efficiency).toBe(0.6);
    // Nothing requested: no efficiency rather than a misleading 0%.
    expect(a.namespaces.find((n) => n.namespace === "batch")!.efficiency).toBeUndefined();
    expect(a.namespaces.find((n) => n.isIdle)?.namespace).toBe(IDLE);
    expect(withoutIdle(a).totalCost).toBe(6);
  });

  it("reads Kubecost v2's data.sets shape", () => {
    const res = { data: { sets: [{ allocations: { web: alloc(1, 1) }, window: { start: "2026-10-01T00:00:00Z" } }] } };
    expect(normalizeAllocation(res, "24h").totalCost).toBe(2);
  });

  it("rejects an unexpected shape", () => {
    expect(() => normalizeAllocation({ nope: true }, "24h")).toThrow();
  });

  it("reads cluster efficiency, skipping idle", () => {
    const res = { data: [{ [IDLE]: {}, c1: { cpuEfficiency: 0.4, ramEfficiency: 0.7, cpuCoreRequestAverage: 2, ramByteRequestAverage: 2 } }] };
    expect(normalizeClusterEfficiency(res)).toEqual({ cpu: 0.4, ram: 0.7 });
  });

  it("fills in the start of empty trend buckets", () => {
    const res = { data: [{ web: { totalCost: 1, window: { start: "2026-10-01T00:00:00Z" } } }, {}, { web: { totalCost: 3 } }] };
    const t = normalizeTrend(res, "7d")!;
    expect(t.buckets.map((b) => new Date(b.startedAt).toISOString().slice(0, 10))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(t.buckets[1].costByNamespace).toEqual({});
  });
});

describe("estimate", () => {
  const node = (name: string, labels: Record<string, string> = {}): KubeObject => ({
    metadata: { name, labels },
    status: { capacity: { cpu: "4", memory: "16Gi" } },
  });
  const rates = ratesFrom({});

  it("charges the larger of requests and usage, and the rest of the node as idle", () => {
    const obs: Observations = {
      window: "24h",
      step: "1h",
      buckets: [
        {
          startedAt: 0,
          hours: 1,
          usage: [{ namespace: "web", node: "n1", cpuReq: 1, cpuUse: 2, ramReq: 4 * GIB, ramUse: 2 * GIB }],
          capacity: [{ node: "n1", cpu: 4, ram: 16 * GIB }],
        },
      ],
    };
    const { allocation, trend } = estimate(obs, [node("n1")], rates);
    const web = allocation.namespaces.find((n) => n.namespace === "web")!;
    expect(web.cpuCost).toBeCloseTo(2 * DEFAULT_RATES.cpu);
    expect(web.ramCost).toBeCloseTo(4 * DEFAULT_RATES.ram);
    expect(web.cpuEfficiency).toBe(2);
    expect(web.ramEfficiency).toBe(0.5);
    const idle = allocation.namespaces.find((n) => n.isIdle)!;
    expect(idle.cpuCost).toBeCloseTo(2 * DEFAULT_RATES.cpu);
    expect(idle.ramCost).toBeCloseTo(12 * DEFAULT_RATES.ram);
    // The whole node for an hour, split between the namespace and idle.
    expect(allocation.totalCost).toBeCloseTo(4 * DEFAULT_RATES.cpu + 16 * DEFAULT_RATES.ram);
    expect(trend.buckets[0].costByNamespace[IDLE]).toBeCloseTo(idle.totalCost);
  });

  it("discounts spot and preemptible nodes (including Yandex Cloud's)", () => {
    const spot = node("p", { "yandex.cloud/preemptible": "true" });
    expect(isSpotNode(spot)).toBe(true);
    expect(nodeRates(spot, rates).cpu).toBeCloseTo(rates.cpu * (1 - rates.spotDiscount));
    expect(nodeRates(node("o"), rates).cpu).toBe(rates.cpu);
  });

  it("uses the cluster's own rates and currency", () => {
    expect(ratesFrom({ costCpuRate: 2.5, costRamRate: 0.3, costCurrency: "rub" })).toMatchObject({ cpu: 2.5, ram: 0.3, currency: "RUB" });
  });
});

describe("segments", () => {
  it("puts idle first and folds namespaces past the palette into Other", () => {
    const namespaces = [
      { namespace: IDLE, totalCost: 10, isIdle: true },
      ...Array.from({ length: 8 }, (_, i) => ({ namespace: `ns${i}`, totalCost: 8 - i })),
    ].map((n) => ({ cpuCost: 0, ramCost: 0, pvCost: 0, networkCost: 0, ...n }));
    const segs = segments({ window: "7d", currency: "USD", totalCost: namespaces.reduce((s, n) => s + n.totalCost, 0), namespaces });
    expect(segs[0].kind).toBe("idle");
    expect(segs.filter((s) => s.kind === "namespace")).toHaveLength(6);
    expect(segs.at(-1)).toMatchObject({ kind: "other", namespaces: ["ns6", "ns7"] });
    expect(segs.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
  });
});
