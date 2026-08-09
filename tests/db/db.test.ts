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
