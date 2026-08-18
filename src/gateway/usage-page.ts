import { type BudgetWindow, summarize } from "../accounts/budget.js";
import { fetchLimits } from "../accounts/limits.js";
import type { Pool } from "../accounts/pool.js";
import { checkReachability } from "../accounts/reachability.js";

export interface UsageSnapshot {
  windows: BudgetWindow[];
  serving: number;
  total: number;
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
export function createUsageSource(pool: Pool, listAccountIds: () => string[], ttlMs = 60_000) {
  let cached: UsageSnapshot | null = null;
  let inFlight: Promise<UsageSnapshot> | null = null;

  async function build(): Promise<UsageSnapshot> {
    const ids = listAccountIds();
    const reach = await checkReachability(pool, ids);
    const serving = reach.filter((r) => r.state === "ok").map((r) => r.accountId);
    const windows = serving.length ? summarize(await fetchLimits(pool, serving)) : [];
    return { windows, serving: serving.length, total: ids.length, takenAt: Date.now() };
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
function paceFraction(name: string, resetAt: number | null, now: number): number | null {
  const len = windowSeconds(name);
  if (!len || !resetAt) return null;
  const remaining = resetAt - now / 1000;
  return Math.max(0, Math.min(1, (len - remaining) / len));
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
.dim{color:var(--dim)}
.sm{font-size:.85rem;margin:0}
</style>
<main>
${rows || empty}
</main>`;
}
