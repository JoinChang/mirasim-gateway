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
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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
      return `<section class="w">
  <div class="hd"><h2>${esc(LABEL[w.name] ?? w.name)}</h2><span class="pct">${pct}%</span></div>
  <div class="bar"><i style="width:${pct}%"></i></div>
  <p class="fig"><b>${money(Math.max(0, w.budgetCents - w.usedCents))}</b> left
     <span class="dim">of ${money(w.budgetCents)}</span></p>
  <p class="dim sm">${esc(reset)}</p>
</section>`;
    })
    .join("\n");

  const empty = `<section class="w"><p class="dim">No account is being served right now.</p></section>`;
  const age = Math.round((now - snap.takenAt) / 1000);

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>mira usage</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a18;--dim:#6b6b66;--line:#e5e4e0;--fill:#3d7a5a;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae5;--dim:#95928a;--line:#2c2a26;--fill:#69ad86;--card:#1e1d1a}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 3rem;background:var(--bg);color:var(--fg);
 font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
main{max-width:34rem;margin:0 auto}
h1{font-size:1.05rem;font-weight:600;letter-spacing:.02em;margin:0 0 1.75rem;color:var(--dim)}
.w{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.15rem;margin:0 0 .85rem}
.hd{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
h2{font-size:.95rem;font-weight:600;margin:0}
.pct{font-variant-numeric:tabular-nums;font-size:.85rem;color:var(--dim)}
.bar{height:6px;border-radius:99px;background:var(--line);overflow:hidden;margin:.7rem 0 .8rem}
.bar i{display:block;height:100%;background:var(--fill);border-radius:99px;transition:width .3s}
.fig{margin:0;font-size:1.02rem;font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.sm{font-size:.85rem;margin:.3rem 0 0}
footer{margin-top:1.5rem;font-size:.82rem;color:var(--dim);text-align:center}
</style>
<main>
  <h1>mira · account pool</h1>
${rows || empty}
  <footer>${snap.serving} of ${snap.total} accounts serving${
    snap.total - snap.serving > 0 ? ` · ${snap.total - snap.serving} not counted` : ""
  }<br>updated ${age}s ago</footer>
</main>`;
}
