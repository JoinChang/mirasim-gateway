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

  it("serves the stale snapshot rather than a 500 when a refresh throws", () => {
    // A relay that is merely down does not reach here: checkReachability turns
    // per-account failures into non-ok states, so an outage renders the honest
    // "nothing is being served" page. This is the path where the refresh itself
    // breaks — the account list is unavailable — and a minute-old number still
    // beats a 500.
    let broken = false;
    const { pool } = fakePool({ respond });
    const src = createUsageSource(
      pool,
      () => {
        if (broken) throw new Error("store unavailable");
        return ["a1"];
      },
      1,
    );
    return src.get().then((first) => {
      broken = true;
      return src.get(Date.now() + 10_000).then((second) => {
        expect(second).toBe(first);
      });
    });
  });

  it("propagates the failure when there is no snapshot to fall back on", async () => {
    const { pool } = fakePool({ respond });
    const src = createUsageSource(pool, () => {
      throw new Error("store unavailable");
    });
    await expect(src.get()).rejects.toThrow("store unavailable");
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

  it("shows the percentage and no money at all", () => {
    const html = renderUsagePage(snap);
    expect(html).toContain("1.5%");
    expect(html).not.toMatch(/\$\d/);
  });

  it("has no page header or footer to frame the numbers", () => {
    const html = renderUsagePage(snap);
    expect(html).not.toMatch(/<h1|<footer|accounts serving|updated /);
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

  it("puts the pace line where a constant burn would have reached by now", () => {
    // 7d window, 3.5d left => half elapsed => the marker sits at 50%.
    const now = Date.now();
    const html = renderUsagePage(
      {
        windows: [
          {
            name: "7d",
            usedCents: 1000,
            budgetCents: 10_000,
            resetAt: Math.floor(now / 1000) + 3.5 * 86400,
            accounts: 1,
            staggered: false,
          },
        ],
        serving: 1,
        total: 1,
        takenAt: now,
      },
      now,
    );
    expect(html).toContain("even pace 50.0%");
    expect(html).toContain("left:50.0%");
  });

  it("flags a window being burned faster than it refills", () => {
    const now = Date.now();
    const win = (usedCents: number) => ({
      windows: [
        {
          name: "7d",
          usedCents,
          budgetCents: 10_000,
          resetAt: Math.floor(now / 1000) + 3.5 * 86400,
          accounts: 1,
          staggered: false,
        },
      ],
      serving: 1,
      total: 1,
      takenAt: now,
    });
    expect(renderUsagePage(win(8000), now)).toContain('class="hot"'); // 80% used, 50% elapsed
    expect(renderUsagePage(win(2000), now)).not.toContain('class="hot"');
  });

  it("omits the pace line when the window length is not knowable", () => {
    const now = Date.now();
    const html = renderUsagePage(
      {
        windows: [{ name: "lifetime", usedCents: 1, budgetCents: 10, resetAt: null, accounts: 1, staggered: false }],
        serving: 1,
        total: 1,
        takenAt: now,
      },
      now,
    );
    expect(html).not.toContain("even pace");
  });
});
