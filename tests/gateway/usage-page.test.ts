import { describe, expect, it } from "vitest";
import { createUsageSource, renderUsagePage, type UsageSnapshot } from "../../src/gateway/usage-page.js";
import { fakePool, R } from "../helpers/fakePool.js";

const LIMITS = {
  subject: "usr_1",
  windows: [{ name: "7d", used: 1137, budget: 74560, reset_at: Math.floor(Date.now() / 1000) + 3600 }],
};
// Reachability asks /v1/models first, then limits asks /v1/limits.
const respond = (req: { pathname: string }) => (req.pathname === "/v1/models" ? R({ data: [{ id: "m" }] }) : R(LIMITS));

describe("createUsageSource", () => {
  it("caches, so a page nobody has to authenticate for cannot be turned into relay load", async () => {
    const { pool, requests } = fakePool({ respond });
    const src = createUsageSource(pool, () => ["a1"], 60_000);
    const t = Date.now();
    await src.get(t);
    const afterFirst = requests.length;
    await src.get(t + 1000);
    await src.get(t + 59_000);
    expect(requests.length).toBe(afterFirst);
  });

  it("refreshes once the TTL is past", async () => {
    const { pool, requests } = fakePool({ respond });
    const src = createUsageSource(pool, () => ["a1"], 1000);
    const t = Date.now();
    await src.get(t);
    const afterFirst = requests.length;
    await src.get(t + 2000);
    expect(requests.length).toBeGreaterThan(afterFirst);
  });

  it("single-flights a cold cache: ten hits at once are one round upstream", async () => {
    const { pool, requests } = fakePool({ respond });
    const src = createUsageSource(pool, () => ["a1"], 60_000);
    const t = Date.now();
    await Promise.all(Array.from({ length: 10 }, () => src.get(t)));
    // Two calls for one account — /v1/models then /v1/limits — not twenty.
    expect(requests.length).toBe(2);
  });

  it("counts only accounts the relay will serve", async () => {
    const { pool } = fakePool({
      respond: (req) => {
        if (req.pathname === "/v1/models")
          return req.onlyAccount === "a1"
            ? R({ data: [{ id: "m" }] })
            : R({ error: { type: "credit_exhausted_shared" } }, 429);
        return R(LIMITS);
      },
    });
    const snap = await createUsageSource(pool, () => ["a1", "a2", "a3"]).get();
    expect(snap).toMatchObject({ serving: 1, total: 3 });
    expect(snap.windows[0]?.accounts).toBe(1);
  });

  it("serves the stale snapshot rather than a 500 when a refresh fails", async () => {
    let fail = false;
    const { pool } = fakePool({
      respond: (req) => {
        if (fail) throw new Error("relay down");
        return respond(req);
      },
    });
    const src = createUsageSource(pool, () => ["a1"], 1);
    const first = await src.get();
    fail = true;
    const second = await src.get(Date.now() + 10_000);
    expect(second.takenAt).toBe(first.takenAt);
  });
});

describe("renderUsagePage", () => {
  const snap: UsageSnapshot = {
    windows: [
      { name: "7d", usedCents: 1137, budgetCents: 74560, resetAt: 2_000_000_000, accounts: 2, staggered: true },
    ],
    serving: 1,
    total: 5,
    takenAt: Date.now(),
  };

  it("shows money left, which is the number people open it for", () => {
    const html = renderUsagePage(snap);
    expect(html).toContain("$734.23");
    expect(html).toContain("$745.60");
  });

  it("names no account — the page is public and pool membership is not part of a spend figure", () => {
    const html = renderUsagePage(snap);
    // Account ids, keys, and the emails they are registered under. `@` alone is
    // too broad to assert on: the stylesheet legitimately contains @media.
    expect(html).not.toMatch(/usr_|acct_|key_|sk-ant|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it("says when a reset is only the first of several", () => {
    expect(renderUsagePage(snap)).toContain("first of several");
  });

  it("says so plainly when nothing is being served", () => {
    expect(renderUsagePage({ windows: [], serving: 0, total: 5, takenAt: Date.now() })).toContain(
      "No account is being served",
    );
  });
});
