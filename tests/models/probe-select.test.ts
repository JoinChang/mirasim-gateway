import { describe, expect, it } from "vitest";
import { selectProbeTargets } from "../../src/models/probe.js";

const row = (model: string, state: string, lastCheckedAt: number) => ({ model, state, lastCheckedAt });
const NOW = 1_000_000;
const TTL = 10_000;

describe("selectProbeTargets", () => {
  it("probes models it has never checked", () => {
    const rows = [row("a", "unknown", 0)];
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 8 })).toEqual(["a"]);
  });

  it("leaves recently checked models alone", () => {
    const rows = [row("fresh", "ok", NOW - 1_000)];
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 8 })).toEqual([]);
  });

  it("rechecks a model once its result has gone stale", () => {
    const rows = [row("stale", "ok", NOW - TTL - 1)];
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 8 })).toEqual(["stale"]);
  });

  it("rechecks unavailable models so recovery is noticed", () => {
    const rows = [row("dead", "unavailable", NOW - TTL - 1)];
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 8 })).toEqual(["dead"]);
  });

  it("takes never-checked models before merely stale ones", () => {
    const rows = [row("stale", "ok", NOW - TTL - 1), row("new", "unknown", 0)];
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 8 })).toEqual(["new", "stale"]);
  });

  it("takes the least recently checked first among stale models", () => {
    const rows = [row("recent", "ok", NOW - TTL - 10), row("ancient", "ok", NOW - TTL - 9999)];
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 8 })).toEqual(["ancient", "recent"]);
  });

  it("never returns more than one cycle's worth", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`m${i}`, "unknown", 0));
    expect(selectProbeTargets(rows, NOW, { ttlMs: TTL, max: 3 })).toHaveLength(3);
  });
});
