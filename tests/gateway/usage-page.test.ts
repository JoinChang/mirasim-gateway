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
    const src = createUsageSource(
      pool,
      () => ["a1"],
      () => [],
      () => [],
      undefined,
      60_000,
    );
    const t = Date.now();
    await src.get(t);
    const afterFirst = requests.length;
    await src.get(t + 1000);
    await src.get(t + 59_000);
    expect(requests.length).toBe(afterFirst);
  });

  it("refreshes once the TTL is past", async () => {
    const { pool, requests } = fakePool({ respond });
    const src = createUsageSource(
      pool,
      () => ["a1"],
      () => [],
      () => [],
      undefined,
      1000,
    );
    const t = Date.now();
    await src.get(t);
    const afterFirst = requests.length;
    await src.get(t + 2000);
    expect(requests.length).toBeGreaterThan(afterFirst);
  });

  it("single-flights a cold cache: ten hits at once are one round upstream", async () => {
    const { pool, requests } = fakePool({ respond });
    const src = createUsageSource(
      pool,
      () => ["a1"],
      () => [],
      () => [],
      undefined,
      60_000,
    );
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
      () => [],
      () => [],
      undefined,
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
    days: [],
    models: [],
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
    expect(renderUsagePage({ windows: [], serving: 0, total: 5, days: [], models: [], takenAt: Date.now() })).toContain(
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
        days: [],
        models: [],
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
      days: [],
      models: [],
      takenAt: now,
    });
    expect(renderUsagePage(win(8000), now)).toContain('class="hot"'); // 80% used, 50% elapsed
    expect(renderUsagePage(win(2000), now)).not.toContain('class="hot"');
  });

  it("omits the pace line when the window length is not knowable", () => {
    const now = Date.now();
    const html = renderUsagePage(
      {
        windows: [{ name: "lifetime", usedCents: 1, budgetCents: 10, resetAt: 0, accounts: 1, staggered: false }],
        serving: 1,
        total: 1,
        days: [],
        models: [],
        takenAt: now,
      },
      now,
    );
    expect(html).not.toContain("even pace");
  });
});

describe("the daily usage chart", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const base = { windows: [], serving: 1, total: 1, models: [], takenAt: now };
  const day = (n: number) => new Date(now - n * 86400_000).toISOString().slice(0, 10);
  const series = (html: string) =>
    JSON.parse(/var d=(\{.*?\}),cs=/s.exec(html)![1]!) as { labels: string[]; values: (number | null)[] };

  it("plots a fixed 14-day span so the gaps keep their width", () => {
    const { labels, values } = series(renderUsagePage({ ...base, days: [{ day: day(0), tokens: 100 }] }, now));
    expect(labels).toHaveLength(14);
    expect(values).toHaveLength(14);
    expect(labels[13]).toBe(day(0));
    expect(labels[0]).toBe(day(13));
  });

  it("leaves quiet days null rather than zero", () => {
    // A day with no activity is a gap, not a flat zero bar — the gap says
    // "nothing happened" more plainly. A day with a tiny but nonzero count is a
    // real bar, floored to a visible height by minBarLength rather than by axis.
    const { values } = series(renderUsagePage({ ...base, days: [{ day: day(3), tokens: 50 }] }, now));
    expect(values[10]).toBe(50);
    expect(values.filter((v) => v !== null)).toHaveLength(1);
    expect(values).not.toContain(0);
  });

  it("uses a linear axis and floors the bar height, not a log scale", () => {
    // Three orders of magnitude apart. A linear axis would flatten the small day
    // to an invisible sliver; minBarLength gives it a floor in pixels while the
    // loud days keep their true, comparable heights.
    const html = renderUsagePage(
      {
        ...base,
        days: [
          { day: day(0), tokens: 137_013 },
          { day: day(1), tokens: 165_927_760 },
        ],
      },
      now,
    );
    expect(html).not.toContain("'logarithmic'");
    expect(html).toContain("minBarLength");
  });

  it("labels the newest day in the configured timezone, not UTC", () => {
    // 2026-08-20T16:09Z is already 2026-08-21 00:09 at +8, so the newest bar must
    // read 08-21 — the bug was a UTC day boundary lagging the operator by 8h.
    const utcEvening = Date.parse("2026-08-20T16:09:00Z");
    const { labels } = series(renderUsagePage({ ...base, days: [{ day: day(0), tokens: 100 }] }, utcEvening, 8));
    expect(labels[13]).toBe("2026-08-21");
    const { labels: utc } = series(renderUsagePage({ ...base, days: [{ day: day(0), tokens: 100 }] }, utcEvening, 0));
    expect(utc[13]).toBe("2026-08-20");
  });

  it("drops the chart entirely when there is nothing to plot", () => {
    expect(renderUsagePage({ ...base, days: [] }, now)).not.toContain("<canvas");
    expect(renderUsagePage({ ...base, days: [{ day: day(0), tokens: 0 }] }, now)).not.toContain("<canvas");
    expect(renderUsagePage({ ...base, days: [{ day: day(40), tokens: 999 }] }, now)).not.toContain("<canvas");
  });

  it("loads the chart library from us, not from a CDN", () => {
    // The page is public: a CDN tag would send every visitor to a third party.
    const html = renderUsagePage({ ...base, days: [{ day: day(0), tokens: 100 }] }, now);
    expect(html).toContain('src="/usage/chart.js"');
    expect(html).not.toMatch(/src="https?:/);
  });

  it("is not dressed as a fourth window card", () => {
    const html = renderUsagePage(
      {
        ...base,
        windows: [
          { name: "7d", usedCents: 1, budgetCents: 100, resetAt: 2_000_000_000, accounts: 1, staggered: false },
        ],
        days: [{ day: day(0), tokens: 100 }],
      },
      now,
    );
    expect(html.match(/class="w"/g)).toHaveLength(1);
    expect(html).toContain('class="tr"');
  });

  it("carries no leftover caption now that the axes are labelled", () => {
    const html = renderUsagePage({ ...base, days: [{ day: day(0), tokens: 100 }] }, now);
    expect(html).not.toContain("peak ");
    expect(html).toContain("Daily Usage");
  });

  it("asks for no favicon the server does not have", () => {
    const html = renderUsagePage({ ...base, days: [{ day: day(0), tokens: 100 }] }, now);
    expect(html).toContain('rel="icon"');
    expect(html).toContain("data:image/svg+xml");
  });

  it("heads both groups the same way, so neither looks like a stray", () => {
    const html = renderUsagePage(
      {
        ...base,
        windows: [
          { name: "7d", usedCents: 1, budgetCents: 100, resetAt: 2_000_000_000, accounts: 1, staggered: false },
        ],
        days: [{ day: day(0), tokens: 100 }],
      },
      now,
    );
    expect(html.match(/class="sh"/g)).toHaveLength(2);
    expect(html).toContain("Limits");
    expect(html).toContain("Daily Usage");
  });
});

describe("the model list", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const base = { windows: [], serving: 1, total: 1, days: [], takenAt: now };
  const m = (model: string, tokens: number) => ({ model, tokens });

  it("orders by weight and shows magnitudes", () => {
    const html = renderUsagePage({ ...base, models: [m("opus", 150_932_228), m("sonnet", 22_504_288)] }, now);
    expect(html.indexOf("opus")).toBeLessThan(html.indexOf("sonnet"));
    expect(html).toContain("150.9M");
    expect(html).toContain("22.5M");
  });

  it("sizes each bar by share of the total", () => {
    const html = renderUsagePage({ ...base, models: [m("a", 750), m("b", 250)] }, now);
    expect(html).toContain("width:75.0%");
    expect(html).toContain("width:25.0%");
  });

  it("rolls the tail into one row rather than spending the section on zeroes", () => {
    // Real data: one model takes 87% and several take a rounding error.
    const models = [m("a", 1_000_000), m("b", 100_000), m("c", 900), m("d", 80), m("e", 7), m("f", 3), m("g", 1)];
    const html = renderUsagePage({ ...base, models }, now);
    expect(html.match(/<li>/g)).toHaveLength(6);
    expect(html).toContain("Other");
    expect(html).not.toContain(">g<");
  });

  it("leaves the tail row off when nothing is left over", () => {
    const html = renderUsagePage({ ...base, models: [m("a", 10), m("b", 5)] }, now);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain("Other");
  });

  it("names an empty model rather than printing a blank row", () => {
    expect(renderUsagePage({ ...base, models: [m("", 10)] }, now)).toContain("unknown");
  });

  it("disappears when nothing has been used", () => {
    expect(renderUsagePage({ ...base, models: [] }, now)).not.toContain("Models");
    expect(renderUsagePage({ ...base, models: [m("a", 0)] }, now)).not.toContain("Models");
  });
});

describe("the stats row", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const base = { windows: [], serving: 1, total: 1, days: [], models: [], takenAt: now };

  const day0 = new Date(now).toISOString().slice(0, 10); // offset 0 → the newest axis day

  it("shows the four totals, a title, and a sparkline per metric", () => {
    const statsByDay = [
      { day: day0, requests: 10, ok: 9, inputTokens: 1000, cachedInputTokens: 600, latencyMsTotal: 5000 },
    ];
    const html = renderUsagePage({ ...base, statsByDay }, now);
    expect(html).toContain("Traffic"); // section title
    expect(html).toContain("Requests");
    expect(html).toContain(">10<"); // request total
    expect(html).toMatch(/90\s*%/); // 9/10 succeeded
    expect(html).toMatch(/60\s*%/); // 600/1000 served from cache
    expect(html).toMatch(/500\s*ms/); // 5000ms / 10 requests
    expect(html).toContain('class="spk"'); // a sparkline is drawn
    expect((html.match(/<polyline/g) ?? []).length).toBe(4); // one per metric
  });

  it("omits the row entirely when there was no traffic", () => {
    expect(renderUsagePage({ ...base, statsByDay: [] }, now)).not.toContain("Traffic");
    const zero = [{ day: day0, requests: 0, ok: 0, inputTokens: 0, cachedInputTokens: 0, latencyMsTotal: 0 }];
    expect(renderUsagePage({ ...base, statsByDay: zero }, now)).not.toContain("Traffic");
  });
});
