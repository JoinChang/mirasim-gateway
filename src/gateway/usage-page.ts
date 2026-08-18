import { type BudgetWindow, summarize } from "../accounts/budget.js";
import { fetchLimits } from "../accounts/limits.js";
import type { Pool } from "../accounts/pool.js";
import { checkReachability } from "../accounts/reachability.js";

export interface DailyTokens {
  day: string;
  tokens: number;
}

export interface UsageSnapshot {
  windows: BudgetWindow[];
  serving: number;
  total: number;
  days: DailyTokens[];
  takenAt: number;
}

/**
 * The numbers behind the public page, cached.
 *
 * The page needs no key, so anything it triggers is something a stranger can
 * trigger as often as they like. Building a snapshot costs two relay calls per
 * account, and a failed one cools that account — an uncached route would let a
 * page refresh loop disable the pool. The TTL is what makes the endpoint safe to
 * expose, not the fact that it only reads.
 *
 * Refreshes are single-flighted for the same reason: ten simultaneous hits on a
 * cold cache must produce one round of upstream calls, not ten.
 */
export function createUsageSource(
  pool: Pool,
  listAccountIds: () => string[],
  listDailyTokens: (sinceMs: number) => DailyTokens[] = () => [],
  ttlMs = 60_000,
) {
  let cached: UsageSnapshot | null = null;
  let inFlight: Promise<UsageSnapshot> | null = null;

  async function build(): Promise<UsageSnapshot> {
    const ids = listAccountIds();
    const reach = await checkReachability(pool, ids);
    const serving = reach.filter((r) => r.state === "ok").map((r) => r.accountId);
    const windows = serving.length ? summarize(await fetchLimits(pool, serving)) : [];
    const now = Date.now();
    // A day of margin past the window the chart draws, so the oldest bar is not
    // half-populated by a query boundary landing mid-day.
    const days = listDailyTokens(now - (DAYS + 1) * 86400_000);
    return { windows, serving: serving.length, total: ids.length, days, takenAt: now };
  }

  return {
    async get(now = Date.now()): Promise<UsageSnapshot> {
      if (cached && now - cached.takenAt < ttlMs) return cached;
      if (inFlight) return inFlight;
      inFlight = build()
        .then((snap) => {
          cached = snap;
          return snap;
        })
        .finally(() => {
          inFlight = null;
        });
      // A refresh that throws must not take the page down with it: serve the
      // stale snapshot if there is one, since a minute-old number beats a 500.
      return inFlight.catch((e) => {
        if (cached) return cached;
        throw e;
      });
    },
  };
}

const LABEL: Record<string, string> = { "5h": "Current session", "7d": "This week", "30d": "This month" };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "3h 47m", "5d 23h" — two units is enough to plan around. */
function until(epochSeconds: number, now: number): string {
  const ms = epochSeconds * 1000 - now;
  if (ms <= 0) return "any moment";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/** "5h"/"7d"/"30d" name its own length, which is what makes a pace line computable. */
function windowSeconds(name: string): number | null {
  const m = /^(\d+)([hd])$/.exec(name);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? 3600 : 86400);
}

/**
 * Where spending would sit right now if the window were burned at a constant
 * rate. Drawn on the bar so a glance answers "am I ahead or behind?" — the
 * percentage alone cannot, because 40% used is early in one window and late in
 * another.
 */
function paceFraction(name: string, resetAt: number, now: number): number | null {
  const len = windowSeconds(name);
  // resetAt is 0 when no contributor reported one — see summarize().
  if (!len || !resetAt) return null;
  const remaining = resetAt - now / 1000;
  return Math.max(0, Math.min(1, (len - remaining) / len));
}

const DAYS = 14;

/**
 * Traffic through this gateway, by UTC day.
 *
 * Deliberately bars and not a line. Real traffic here is bursty — one heavy day
 * then nothing for a week — and a line drawn between two distant points invents
 * a slope across days that saw no requests at all. Bars leave the gaps visible.
 *
 * A day×hour heatmap was the other candidate and does not fit this data: ten of
 * 240 cells carry any tokens, so it would render as a mostly empty grid.
 */
function renderChart(days: DailyTokens[], now: number): string {
  if (!days.length) return "";
  // Fill the quiet days back in. Their absence is the point: the gaps are what
  // make a burst legible as a burst.
  const byDay = new Map(days.map((d) => [d.day, d.tokens]));
  const series: DailyTokens[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
    series.push({ day, tokens: byDay.get(day) ?? 0 });
  }
  const peak = Math.max(...series.map((d) => d.tokens));
  if (peak <= 0) return "";

  const W = 100;
  const H = 32;
  const gap = 1.2;
  const bw = (W - gap * (series.length - 1)) / series.length;
  const bars = series
    .map((d, i) => {
      // Square root, not linear: one burst day dwarfs the rest by two orders of
      // magnitude, and on a linear scale every other day flattens into nothing.
      const h = d.tokens > 0 ? Math.max(1.5, Math.sqrt(d.tokens / peak) * H) : 0;
      if (h === 0) return "";
      const x = i * (bw + gap);
      return `<rect x="${x.toFixed(2)}" y="${(H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="0.6"><title>${d.day}: ${fmtTokens(d.tokens)} tokens</title></rect>`;
    })
    .join("");

  // Not a fourth `.w` card. The windows above are bounded — they have a
  // denominator and they reset, and they answer "can I use this right now?".
  // Traffic is unbounded history answering "what has been happening?". Giving
  // the two the same chrome claims they are the same kind of fact.
  return `<section class="tr">
  <div class="trh"><h2>Traffic</h2><span class="dim sm">via this gateway · ${DAYS}d</span></div>
  <svg class="ch" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
       aria-label="Daily token throughput over the last ${DAYS} days">${bars}</svg>
  <p class="dim sm">${esc(series[0]!.day)} — ${esc(series[series.length - 1]!.day)} · peak ${fmtTokens(peak)} tokens/day</p>
</section>`;
}

/** "1.2M", "7.4k" — the magnitude is the message, not the digits. */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * The page is deliberately anonymous: totals only, never an account id, an email
 * or a per-account figure. It is served without a key, so everything on it is
 * public, and the pool's membership is not something a spend figure needs.
 */
export function renderUsagePage(snap: UsageSnapshot, now = Date.now()): string {
  const rows = snap.windows
    .map((w) => {
      const frac = w.budgetCents > 0 ? Math.min(1, w.usedCents / w.budgetCents) : 0;
      const pct = (frac * 100).toFixed(1);
      const reset = w.resetAt
        ? `resets in ${until(w.resetAt, now)}${w.staggered ? " (first of several)" : ""}`
        : "no reset reported";
      const pace = paceFraction(w.name, w.resetAt, now);
      const pacePct = pace === null ? null : (pace * 100).toFixed(1);
      // Ahead of the line means spending faster than the window refills.
      const ahead = pace !== null && frac > pace;
      return `<section class="w">
  <h2>${esc(LABEL[w.name] ?? w.name)}</h2>
  <p class="pct">${pct}%<span class="of"> used</span></p>
  <div class="bar"><i class="${ahead ? "hot" : ""}" style="width:${pct}%"></i>${
    pacePct === null ? "" : `<u style="left:${pacePct}%" title="even pace: ${pacePct}%"></u>`
  }</div>
  <p class="dim sm">${esc(reset)}${pacePct === null ? "" : ` · even pace ${pacePct}%`}</p>
</section>`;
    })
    .join("\n");

  const empty = `<section class="w"><p class="dim">No account is being served right now.</p></section>`;

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Mirasim Usage</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a18;--dim:#6b6b66;--line:#e5e4e0;--fill:#3d7a5a;--over:#b8763a;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae5;--dim:#95928a;--line:#2c2a26;--fill:#69ad86;--over:#d99a55;--card:#1e1d1a}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 3rem;background:var(--bg);color:var(--fg);
 font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
main{max-width:34rem;margin:0 auto}
.w{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.15rem;margin:0 0 .85rem}
h2{font-size:.85rem;font-weight:500;letter-spacing:.02em;margin:0;color:var(--dim)}
.pct{margin:.1rem 0 0;font-size:1.75rem;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.of{font-size:.85rem;font-weight:400;color:var(--dim)}
.bar{position:relative;height:6px;border-radius:99px;background:var(--line);margin:.75rem 0 .8rem}
.bar i{display:block;height:100%;background:var(--fill);border-radius:99px;transition:width .3s}
.bar i.hot{background:var(--over)}
.bar u{position:absolute;top:-3px;width:2px;height:12px;border-radius:1px;background:var(--fg);opacity:.45;transform:translateX(-1px)}
.tr{margin:1.6rem .15rem 0;padding-top:1.15rem;border-top:1px solid var(--line)}
.trh{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.ch{display:block;width:100%;height:3rem;margin:.8rem 0 .5rem;fill:var(--fill)}
.dim{color:var(--dim)}
.sm{font-size:.85rem;margin:0}
</style>
<main>
${rows || empty}
${renderChart(snap.days, now)}
</main>`;
}
