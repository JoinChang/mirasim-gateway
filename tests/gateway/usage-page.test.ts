import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  createUsageSource,
  DEFAULT_RANGE,
  parseRange,
  renderSections,
  renderUsagePage,
  type UsageSnapshot,
} from "../../src/gateway/usage-page.js";
import { fakePool, R } from "../helpers/fakePool.js";

const LIMITS = {
  subject: "usr_1",
  windows: [{ name: "7d", used: 1137, budget: 74560, reset_at: Math.floor(Date.now() / 1000) + 3600 }],
};
// Reachability asks /v1/models first, then limits asks /v1/limits.
const respond = (req: { pathname: string }) => (req.pathname === "/v1/models" ? R({ data: [{ id: "m" }] }) : R(LIMITS));

type RD = {
  days?: { day: string; tokens: number }[];
  models?: { model: string; tokens: number }[];
  statsByDay?: {
    day: string;
    requests: number;
    ok: number;
    inputTokens: number;
    cachedInputTokens: number;
    latencyMsTotal: number;
  }[];
};
const rd = (o: RD = {}) => ({ days: o.days ?? [], models: o.models ?? [], statsByDay: o.statsByDay ?? [] });
const mkSnap = (
  now: number,
  over: Partial<Record<"24h" | "7d" | "30d", RD>> = {},
  extra: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  windows: [],
  serving: 1,
  total: 1,
  takenAt: now,
  byRange: { "24h": rd(over["24h"]), "7d": rd(over["7d"]), "30d": rd(over["30d"]) },
  ...extra,
});

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
    expect(requests.length).toBe(2);
  });

  it("builds every range in one go so the client can switch without a request", async () => {
    const { pool } = fakePool({ respond });
    const src = createUsageSource(
      pool,
      () => ["a1"],
      (_since, bucket) => (bucket === "hour" ? [{ day: "h", tokens: 1 }] : [{ day: "d", tokens: 2 }]),
      () => [{ model: "m", tokens: 3 }],
      () => [],
    );
    const snap = await src.get();
    expect(Object.keys(snap.byRange).sort()).toEqual(["24h", "30d", "7d"]);
    expect(snap.byRange["24h"].days).toEqual([{ day: "h", tokens: 1 }]); // hourly bucket
    expect(snap.byRange["7d"].days).toEqual([{ day: "d", tokens: 2 }]); // daily bucket
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
        expect(second.takenAt).toBe(first.takenAt);
        expect(second.serving).toBe(first.serving);
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

describe("parseRange", () => {
  it("accepts the three known ranges", () => {
    expect(parseRange("24h")).toBe("24h");
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("30d")).toBe("30d");
  });
  it("falls back to the default for anything else", () => {
    expect(DEFAULT_RANGE).toBe("7d");
    expect(parseRange(undefined)).toBe("7d");
    expect(parseRange("")).toBe("7d");
    expect(parseRange("90d")).toBe("7d");
    expect(parseRange("../etc")).toBe("7d");
  });
});

describe("renderUsagePage (the shell)", () => {
  const now = Date.now();
  const snap = mkSnap(
    now,
    {},
    {
      windows: [
        { name: "7d", usedCents: 1137, budgetCents: 74560, resetAt: 2_000_000_000, accounts: 2, staggered: true },
      ],
      serving: 1,
      total: 5,
    },
  );

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
    expect(html).not.toMatch(/usr_|acct_|key_|sk-ant|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it("carries an auto-refresh toggle on the Limits header, above the swap region", () => {
    const html = renderUsagePage(snap);
    expect(html).toContain('id="ar"');
    expect(html).toContain("Auto-refresh");
    expect(html).toMatch(/Limits<\/span><label class="ar-l"/);
    expect(html.indexOf("Auto-refresh")).toBeLessThan(html.indexOf('<div id="u"'));
    expect(html).toMatch(/<div id="u"[^>]*data-tokens="7d"/);
  });

  it("says when a reset is only the first of several", () => {
    expect(renderUsagePage(snap)).toContain("first of several");
  });

  it("says so plainly when nothing is being served", () => {
    expect(renderUsagePage(mkSnap(now, {}, { serving: 0, total: 5 }))).toContain("No account is being served");
  });

  it("puts the pace line where a constant burn would have reached by now", () => {
    const t = Date.now();
    const html = renderUsagePage(
      mkSnap(
        t,
        {},
        {
          windows: [
            {
              name: "7d",
              usedCents: 1000,
              budgetCents: 10_000,
              resetAt: Math.floor(t / 1000) + 3.5 * 86400,
              accounts: 1,
              staggered: false,
            },
          ],
        },
      ),
      t,
    );
    expect(html).toContain("even pace 50.0%");
    expect(html).toContain("left:50.0%");
  });

  it("flags a window being burned faster than it refills", () => {
    const t = Date.now();
    const win = (usedCents: number) =>
      mkSnap(
        t,
        {},
        {
          windows: [
            {
              name: "7d",
              usedCents,
              budgetCents: 10_000,
              resetAt: Math.floor(t / 1000) + 3.5 * 86400,
              accounts: 1,
              staggered: false,
            },
          ],
        },
      );
    expect(renderUsagePage(win(8000), t)).toContain('class="hot"');
    expect(renderUsagePage(win(2000), t)).not.toContain('class="hot"');
  });

  it("omits the pace line when the window length is not knowable", () => {
    const t = Date.now();
    const html = renderUsagePage(
      mkSnap(
        t,
        {},
        { windows: [{ name: "lifetime", usedCents: 1, budgetCents: 10, resetAt: 0, accounts: 1, staggered: false }] },
      ),
      t,
    );
    expect(html).not.toContain("even pace");
  });
});

describe("renderSections (the fragment)", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const day = (n: number) => new Date(now - n * 86400_000).toISOString().slice(0, 10);

  it("returns inner HTML with no document shell, controller, or the persistent toggle", () => {
    const frag = renderSections(
      mkSnap(
        now,
        { "7d": { days: [{ day: day(0), tokens: 100 }] } },
        {
          windows: [
            { name: "7d", usedCents: 1, budgetCents: 100, resetAt: 2_000_000_000, accounts: 1, staggered: false },
          ],
        },
      ),
      now,
    );
    expect(frag).not.toContain("<!doctype");
    expect(frag).not.toContain("<html");
    expect(frag).not.toContain('src="/usage/chart.js"'); // the shell owns the library tag
    expect(frag).not.toContain("addEventListener"); // and the controller
    expect(frag).not.toContain("Auto-refresh"); // and the persistent toggle
    expect(frag).toContain('class="w"'); // but the limits cards ARE here — they refresh
    expect(frag).toContain("Token Usage");
  });
});

describe("the time-range switchers", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const day = (n: number) => new Date(now - n * 86400_000).toISOString().slice(0, 10);
  const controllerJs = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const full = () =>
    renderUsagePage(
      mkSnap(now, {
        "7d": {
          days: [{ day: day(0), tokens: 100 }],
          models: [{ model: "m", tokens: 100 }],
          statsByDay: [
            { day: day(0), requests: 5, ok: 5, inputTokens: 100, cachedInputTokens: 50, latencyMsTotal: 500 },
          ],
        },
      }),
      now,
    );

  it("gives each switchable section its own switcher, none on Limits", () => {
    const html = full();
    expect(html).toContain('data-sw="tokens"');
    expect(html).toContain('data-sw="traffic"');
    expect(html).toContain('data-sw="models"');
    expect(html).not.toContain('data-sw="limits"');
  });

  it("starts every switcher on 7d", () => {
    const html = full();
    expect((html.match(/data-range="7d" class="on"/g) ?? []).length).toBe(3);
    expect(html).not.toContain('data-range="24h" class="on"');
  });

  it("switches client-side (a range click toggles locally, never fetches)", () => {
    const js = controllerJs(full());
    // The click handler updates the section's range and re-applies locally.
    expect(js).toContain("data-range');apply()");
    // The only fetch is the auto-refresh poll, not the switch.
    expect(js).toContain("setInterval(refresh,30000)");
    expect(js).toContain("fetch('/usage?fragment=1");
  });
});

describe("the token usage chart", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const day = (n: number) => new Date(now - n * 86400_000).toISOString().slice(0, 10);
  const hour = (n: number) => new Date(now - n * 3600_000).toISOString().slice(0, 13);
  const cd = (html: string) =>
    JSON.parse(/<script type="application\/json" id="cd">(.*?)<\/script>/.exec(html)![1]!) as Record<
      "24h" | "7d" | "30d",
      { labels: string[]; values: (number | null)[]; bucket: string }
    >;
  const controllerJs = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const page = (over: Partial<Record<"24h" | "7d" | "30d", RD>>, at = now, off = 0) =>
    renderUsagePage(mkSnap(now, over), at, off);

  it("embeds all three ranges so switching is a local redraw (7 daily / 30 daily / 24 hourly)", () => {
    const c = cd(page({ "7d": { days: [{ day: day(0), tokens: 100 }] } }));
    expect(c["7d"].labels).toHaveLength(7);
    expect(c["7d"].bucket).toBe("day");
    expect(c["30d"].labels).toHaveLength(30);
    expect(c["24h"].labels).toHaveLength(24);
    expect(c["24h"].bucket).toBe("hour");
    expect(c["24h"].labels.every((l) => l.includes("T"))).toBe(true);
    expect(c["24h"].labels[23]).toBe(hour(0));
  });

  it("labels the 7d axis oldest to newest, in the configured timezone", () => {
    const utcEvening = Date.parse("2026-08-20T16:09:00Z");
    const c = cd(page({ "7d": { days: [{ day: day(0), tokens: 100 }] } }, utcEvening, 8));
    expect(c["7d"].labels[6]).toBe("2026-08-21");
    expect(c["7d"].labels[0]).toBe("2026-08-15");
  });

  it("leaves quiet buckets null rather than zero", () => {
    const c = cd(page({ "7d": { days: [{ day: day(3), tokens: 50 }] } }));
    expect(c["7d"].values).toHaveLength(7);
    expect(c["7d"].values[3]).toBe(50);
    expect(c["7d"].values.filter((v) => v !== null)).toHaveLength(1);
    expect(c["7d"].values).not.toContain(0);
  });

  it("uses a linear axis and floors the bar height, not a log scale", () => {
    const html = page({ "7d": { days: [{ day: day(0), tokens: 137_013 }] } });
    expect(html).not.toContain("'logarithmic'");
    expect(html).toContain("minBarLength");
  });

  it("is titled Token Usage, not Daily Usage", () => {
    const html = page({ "7d": { days: [{ day: day(0), tokens: 100 }] } });
    expect(html).toContain("Token Usage");
    expect(html).not.toContain("Daily Usage");
  });

  it("drops the whole section when no range has any tokens", () => {
    expect(page({})).not.toContain("Token Usage");
    expect(page({})).not.toContain("<canvas");
    expect(page({ "7d": { days: [{ day: day(0), tokens: 0 }] } })).not.toContain("<canvas");
  });

  it("loads the chart library from us, not from a CDN", () => {
    const html = page({ "7d": { days: [{ day: day(0), tokens: 100 }] } });
    expect(html).toContain('src="/usage/chart.js"');
    expect(html).not.toMatch(/src="https?:/);
  });

  it("emits a syntactically valid controller script, with a chart and without", () => {
    expect(() => new vm.Script(controllerJs(page({ "7d": { days: [{ day: day(0), tokens: 100 }] } })))).not.toThrow();
    expect(() => new vm.Script(controllerJs(page({})))).not.toThrow();
  });
});

describe("the model list", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const m = (model: string, tokens: number) => ({ model, tokens });
  const page = (over: Partial<Record<"24h" | "7d" | "30d", RD>>) => renderUsagePage(mkSnap(now, over), now);

  it("pre-renders a panel per range, 7d visible and the others hidden", () => {
    const html = page({
      "24h": { models: [m("recent", 5)] },
      "7d": { models: [m("opus", 150_932_228), m("sonnet", 22_504_288)] },
      "30d": { models: [m("older", 9)] },
    });
    expect(html).toContain("Models");
    expect(html).toMatch(/<div class="rp" data-range="7d">/); // default visible
    expect(html).toMatch(/<div class="rp" data-range="24h" hidden>/);
    expect(html).toMatch(/<div class="rp" data-range="30d" hidden>/);
    expect(html).toContain("150.9M"); // 7d content present
    expect(html).toContain("recent"); // 24h content also shipped (hidden)
  });

  it("orders by weight and shows magnitudes", () => {
    const html = page({ "7d": { models: [m("opus", 150_932_228), m("sonnet", 22_504_288)] } });
    expect(html.indexOf("opus")).toBeLessThan(html.indexOf("sonnet"));
    expect(html).toContain("150.9M");
    expect(html).toContain("22.5M");
  });

  it("sizes each bar by share of the total", () => {
    const html = page({ "7d": { models: [m("a", 750), m("b", 250)] } });
    expect(html).toContain("width:75.0%");
    expect(html).toContain("width:25.0%");
  });

  it("rolls the tail into one row rather than spending the section on zeroes", () => {
    const models = [m("a", 1_000_000), m("b", 100_000), m("c", 900), m("d", 80), m("e", 7), m("f", 3), m("g", 1)];
    const html = page({ "7d": { models } });
    expect(html.match(/<li>/g)).toHaveLength(6);
    expect(html).toContain("Other");
    expect(html).not.toContain(">g<");
  });

  it("names an empty model rather than printing a blank row", () => {
    expect(page({ "7d": { models: [m("", 10)] } })).toContain("unknown");
  });

  it("disappears when no range has any model usage", () => {
    expect(page({})).not.toContain("Models");
    expect(page({ "7d": { models: [m("a", 0)] } })).not.toContain("Models");
  });
});

describe("the traffic row", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const day0 = new Date(now).toISOString().slice(0, 10);
  const stat = { day: day0, requests: 10, ok: 9, inputTokens: 1000, cachedInputTokens: 600, latencyMsTotal: 5000 };
  const page = (over: Partial<Record<"24h" | "7d" | "30d", RD>>) => renderUsagePage(mkSnap(now, over), now);

  it("shows the four totals, a title, and a sparkline per metric in the visible range", () => {
    const html = page({ "7d": { statsByDay: [stat] } });
    expect(html).toContain("Traffic");
    expect(html).toContain("Requests");
    expect(html).toContain(">10<");
    expect(html).toMatch(/90\s*%/);
    expect(html).toMatch(/60\s*%/);
    expect(html).toMatch(/500\s*ms/);
    expect(html).toContain('class="spk"');
    // Only the visible 7d panel has data; 24h/30d panels are empty notes.
    expect((html.match(/class="spk-l"/g) ?? []).length).toBe(4);
    expect(html).toContain('class="spk-a"');
    expect(html).toContain('class="spk-d"');
  });

  it("pre-renders a panel per range, 7d visible and the others hidden", () => {
    const html = page({ "7d": { statsByDay: [stat] } });
    expect(html).toMatch(/<div class="rp" data-range="7d">/);
    expect(html).toMatch(/<div class="rp" data-range="24h" hidden>/);
    expect(html).toMatch(/<div class="rp" data-range="30d" hidden>/);
  });

  it("draws the end dot so it stays circular under the stretched viewBox", () => {
    const html = page({ "7d": { statsByDay: [stat] } });
    expect(html).not.toMatch(/<circle[^>]*class="spk-d"/);
    expect(html).toMatch(/<(?:path|line)[^>]*class="spk-d"/);
    expect(html).toMatch(/\.spk-d\{[^}]*vector-effect:non-scaling-stroke/);
    expect(html).toMatch(/\.spk-d\{[^}]*stroke-linecap:round/);
  });

  it("omits the row entirely when no range had traffic", () => {
    expect(page({})).not.toContain("Traffic");
    const zero = [{ day: day0, requests: 0, ok: 0, inputTokens: 0, cachedInputTokens: 0, latencyMsTotal: 0 }];
    expect(page({ "7d": { statsByDay: zero } })).not.toContain("Traffic");
  });
});
