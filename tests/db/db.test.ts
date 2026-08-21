import { describe, expect, it } from "vitest";
import { memDb } from "../../src/db/client.js";
import { accountsRepo } from "../../src/db/repositories/accounts.js";
import { keysRepo } from "../../src/db/repositories/keys.js";
import { kvRepo } from "../../src/db/repositories/kv.js";
import { usageRepo } from "../../src/db/repositories/usage.js";

describe("db client + repositories", () => {
  it("migrate creates tables; accounts CRUD", () => {
    const db = memDb();
    const repo = accountsRepo(db);
    repo.upsert({ id: "usr_1", email: "a@b.c", plan: "max", refreshToken: "rt1" });
    expect(repo.get("usr_1")?.email).toBe("a@b.c");
    repo.setDisabledUntil("usr_1", 999);
    expect(repo.get("usr_1")?.disabledUntil).toBe(999);
    repo.upsert({ id: "usr_1", email: "a@b.c", plan: "max", refreshToken: "rt2" }); // upsert updates
    expect(repo.get("usr_1")?.refreshToken).toBe("rt2");
    expect(repo.list()).toHaveLength(1);
    repo.remove("usr_1");
    expect(repo.get("usr_1")).toBeUndefined();
  });

  it("keys: create/findByHash/count/revoke", () => {
    const db = memDb();
    const k = keysRepo(db);
    expect(k.count()).toBe(0);
    k.create({ id: "k1", keyHash: "h1", label: "default", rpmLimit: 60, dailyTokenLimit: null });
    expect(k.findByHash("h1")?.label).toBe("default");
    expect(k.count()).toBe(1);
    k.revoke("k1");
    expect(k.findByHash("h1")?.enabled).toBe(0);
  });

  it("usage.dailyStats aggregates per offset-shifted day: requests, ok, tokens, cache, latency", () => {
    const db = memDb();
    const u = usageRepo(db);
    const base = {
      downstreamKeyId: null,
      accountId: null,
      dialect: "messages",
      model: "m",
      webSearchRequests: 0,
      outputTokens: 0,
      viaRelay: 0,
      cost: null,
    };
    // Two on 2026-08-20 UTC (one a 429); one at 20:00Z, which is 2026-08-21 at +8,
    // so it lands on a separate local day.
    u.append({
      ts: Date.parse("2026-08-20T04:00:00Z"),
      status: 200,
      inputTokens: 100,
      cachedInputTokens: 80,
      latencyMs: 300,
      ...base,
    });
    u.append({
      ts: Date.parse("2026-08-20T05:00:00Z"),
      status: 429,
      inputTokens: 0,
      cachedInputTokens: 0,
      latencyMs: 20,
      ...base,
    });
    u.append({
      ts: Date.parse("2026-08-20T20:00:00Z"),
      status: 200,
      inputTokens: 50,
      cachedInputTokens: 10,
      latencyMs: 100,
      ...base,
    });
    expect(u.dailyStats(0, 8)).toEqual([
      { day: "2026-08-20", requests: 2, ok: 1, inputTokens: 100, cachedInputTokens: 80, latencyMsTotal: 320 },
      { day: "2026-08-21", requests: 1, ok: 1, inputTokens: 50, cachedInputTokens: 10, latencyMsTotal: 100 },
    ]);
  });

  it("usage.dailyTokens groups by the offset-shifted local day", () => {
    const db = memDb();
    const u = usageRepo(db);
    const base = {
      downstreamKeyId: null,
      accountId: null,
      dialect: "messages",
      model: "m",
      webSearchRequests: 0,
      viaRelay: 0,
      cost: null,
      latencyMs: 0,
      status: 200,
    };
    // 2026-08-20T20:00Z is 2026-08-21 04:00 at +8 → a different local day than UTC.
    u.append({ ts: Date.parse("2026-08-20T20:00:00Z"), inputTokens: 10, outputTokens: 0, ...base });
    expect(u.dailyTokens(0, 0).find((d) => d.day === "2026-08-20")?.tokens).toBe(10);
    expect(u.dailyTokens(0, 8).find((d) => d.day === "2026-08-21")?.tokens).toBe(10);
  });

  it("usage.dailyTokensForKey sums in+out since day start", () => {
    const db = memDb();
    const u = usageRepo(db);
    const base = {
      downstreamKeyId: "k1",
      accountId: "a",
      dialect: "messages",
      model: "m",
      webSearchRequests: 0,
      status: 200,
      viaRelay: 0,
      cost: null,
      latencyMs: 1,
    };
    u.append({ ts: 1000, inputTokens: 10, outputTokens: 5, ...base });
    u.append({ ts: 2000, inputTokens: 3, outputTokens: 2, ...base });
    u.append({ ts: 500, inputTokens: 100, outputTokens: 100, ...base }); // before window
    expect(u.dailyTokensForKey("k1", 1000)).toBe(20);
  });

  it("kv get/set", () => {
    const db = memDb();
    const kv = kvRepo(db);
    expect(kv.get("x")).toBeUndefined();
    kv.set("x", "v1");
    expect(kv.get("x")).toBe("v1");
    kv.set("x", "v2");
    expect(kv.get("x")).toBe("v2");
  });
});
