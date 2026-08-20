import { type BudgetWindow, summarize } from "../accounts/budget.js";
import { fetchLimits } from "../accounts/limits.js";
import type { Pool } from "../accounts/pool.js";
import { checkReachability } from "../accounts/reachability.js";

export interface DailyTokens {
  day: string;
  tokens: number;
}

export interface ModelTokens {
  model: string;
  tokens: number;
}

export interface UsageSnapshot {
  windows: BudgetWindow[];
  serving: number;
  total: number;
  days: DailyTokens[];
  models: ModelTokens[];
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
  listModelTokens: (sinceMs: number) => ModelTokens[] = () => [],
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
    const since = now - (DAYS + 1) * 86400_000;
    const days = listDailyTokens(since);
    const models = listModelTokens(since);
    return { windows, serving: serving.length, total: ids.length, days, models, takenAt: now };
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

/** A gauge glyph for the bounded windows, echoing the bars inside their cards. */
const ICON_LIMITS = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="6.5" width="14" height="3" rx="1.5" opacity=".3"/><rect x="1" y="6.5" width="6" height="3" rx="1.5"/></svg>`;

/** A bar-chart glyph, inline so the page still owes nothing to a third party. */
const ICON_DAILY = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="9" width="3" height="5.5" rx="1"/><rect x="6.5" y="5" width="3" height="9.5" rx="1"/><rect x="11.5" y="1.5" width="3" height="13" rx="1"/></svg>`;

/** The YYYY-MM-DD the instant falls on in the offset timezone. */
function dayKey(ms: number, offsetHours: number): string {
  return new Date(ms + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Tokens per day, drawn by Chart.js on a linear axis with a floored bar height.
 *
 * The spread here is three orders of magnitude — a 165M-token day next to a 137k
 * one — so a bare linear axis flattens the small days into invisible slivers. The
 * fix is a pixel floor, not a scale: `minBarLength` gives every real day a
 * minimum height while the loud days keep their true, comparable heights. A log
 * axis did the compression too, but it distorted the comparison the chart is for.
 *
 * A day is null, not zero, only when nothing happened at all — Chart.js skips a
 * null and leaves a true gap, whereas `minBarLength` would floor even a zero into
 * a visible bar. So the gap means "completely nothing"; any nonzero day, however
 * small, is a floored bar.
 */
function renderChart(days: DailyTokens[], now: number, offsetHours: number): string {
  const byDay = new Map(days.map((d) => [d.day, d.tokens]));
  const labels: string[] = [];
  const values: (number | null)[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86400_000, offsetHours);
    labels.push(day);
    const t = byDay.get(day) ?? 0;
    values.push(t > 0 ? t : null);
  }
  if (!values.some((v) => v !== null)) return "";

  const data = JSON.stringify({ labels, values });
  return `<section class="tr">
  <h3 class="sh">${ICON_DAILY}Daily Usage</h3>
  <div class="chw"><canvas id="ch"></canvas></div>
  <script src="/usage/chart.js"></script>
  <script>${chartScript(data)}</script>
</section>`;
}

/** Kept out of the markup above so the template stays readable. */
function chartScript(data: string): string {
  return `(function(){
var d=${data},cs=getComputedStyle(document.documentElement);
var fg=cs.getPropertyValue('--fg').trim(),dim=cs.getPropertyValue('--dim').trim();
var line=cs.getPropertyValue('--line').trim(),fill=cs.getPropertyValue('--fill').trim();
function fmt(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n)}
new Chart(document.getElementById('ch'),{type:'bar',
data:{labels:d.labels.map(function(s){return s.slice(5)}),
datasets:[{data:d.values,backgroundColor:fill,borderRadius:2,borderSkipped:false,minBarLength:3}]},
options:{responsive:true,maintainAspectRatio:false,animation:false,
plugins:{legend:{display:false},tooltip:{displayColors:false,
callbacks:{title:function(i){return d.labels[i[0].dataIndex]},
label:function(c){return fmt(c.parsed.y)+' tokens'}}}},
scales:{x:{grid:{display:false},border:{color:line},
ticks:{color:dim,font:{size:10},maxRotation:0,autoSkipPadding:8}},
y:{beginAtZero:true,grid:{color:line},border:{display:false},
ticks:{color:dim,font:{size:10},maxTicksLimit:4,callback:function(v){return fmt(v)}}}}}})
})()`;
}

const MODEL_ROWS = 5;

/** A stacked-rows glyph for the per-model split. */
const ICON_MODELS = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2.5" width="14" height="2.6" rx="1.3"/><rect x="1" y="6.7" width="10" height="2.6" rx="1.3" opacity=".65"/><rect x="1" y="10.9" width="6" height="2.6" rx="1.3" opacity=".35"/></svg>`;

/** "1.2M", "7.4k" — the magnitude is the message, not the digits. */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * Which models the tokens went to, over the same 14 days the chart covers, so
 * the two sections describe one period rather than two.
 *
 * The tail is rolled into one row. The split here is lopsided — one model takes
 * most of it and several take a rounding error — and a row per model would
 * spend most of the section on entries that round to zero percent.
 */
function renderModels(models: ModelTokens[]): string {
  const rows = models.filter((m) => m.tokens > 0);
  if (!rows.length) return "";
  const total = rows.reduce((sum, m) => sum + m.tokens, 0);

  const shown = rows.slice(0, MODEL_ROWS);
  const restTokens = rows.slice(MODEL_ROWS).reduce((sum, m) => sum + m.tokens, 0);
  if (restTokens > 0) shown.push({ model: "Other", tokens: restTokens });

  const items = shown
    .map((m) => {
      const pct = ((m.tokens / total) * 100).toFixed(1);
      return `<li>
    <div class="mr"><span class="mn">${esc(m.model || "unknown")}</span><span class="mt">${fmtTokens(m.tokens)}</span></div>
    <div class="bar mb"><i style="width:${pct}%"></i></div>
  </li>`;
    })
    .join("\n  ");

  return `<section class="tr">
  <h3 class="sh">${ICON_MODELS}Models</h3>
  <ul class="ml">
  ${items}
  </ul>
</section>`;
}

/**
 * The page is deliberately anonymous: totals only, never an account id, an email
 * or a per-account figure. It is served without a key, so everything on it is
 * public, and the pool's membership is not something a spend figure needs.
 */
export function renderUsagePage(snap: UsageSnapshot, now = Date.now(), offsetHours = 0): string {
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1.5' y='9' width='3' height='5.5' rx='1' fill='%233d7a5a'/%3E%3Crect x='6.5' y='5' width='3' height='9.5' rx='1' fill='%233d7a5a'/%3E%3Crect x='11.5' y='1.5' width='3' height='13' rx='1' fill='%233d7a5a'/%3E%3C/svg%3E">
<title>Mirasim Usage</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a18;--dim:#6b6b66;--line:#e5e4e0;--fill:#3d7a5a;--over:#b8763a;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae5;--dim:#95928a;--line:#2c2a26;--fill:#69ad86;--over:#d99a55;--card:#1e1d1a}}
*{box-sizing:border-box}
body{margin:0;padding:1.25rem 1.25rem 2.5rem;background:var(--bg);color:var(--fg);
 font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
main{max-width:34rem;margin:0 auto}
.w{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.15rem;margin:0 0 .85rem}
h2{font-size:.85rem;font-weight:500;letter-spacing:.02em;margin:0;color:var(--dim)}
.sh{display:flex;align-items:center;font-size:.85rem;font-weight:600;letter-spacing:.02em;margin:0 0 .7rem .15rem;color:var(--fg)}
.pct{margin:.1rem 0 0;font-size:1.75rem;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.of{font-size:.85rem;font-weight:400;color:var(--dim)}
.bar{position:relative;height:6px;border-radius:99px;background:var(--line);margin:.75rem 0 .8rem}
.bar i{display:block;height:100%;background:var(--fill);border-radius:99px;transition:width .3s}
.bar i.hot{background:var(--over)}
.bar u{position:absolute;top:-3px;width:2px;height:12px;border-radius:1px;background:var(--fg);opacity:.45;transform:translateX(-1px)}
.tr{margin:1.5rem .15rem 0;padding-top:1.2rem;border-top:1px solid var(--line)}
.chw{position:relative;height:8rem;margin:.9rem 0 .1rem}
.ic{width:.8rem;height:.8rem;fill:currentColor;margin-right:.4rem;vertical-align:-.05rem}
.ml{list-style:none;margin:0;padding:0}
.ml li{margin:0 0 .7rem}
.ml li:last-child{margin-bottom:0}
.mr{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;font-size:.85rem}
.mn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt{color:var(--dim);font-variant-numeric:tabular-nums;flex:none}
.mb{height:4px;margin:.35rem 0 0}
.dim{color:var(--dim)}
.sm{font-size:.85rem;margin:0}
</style>
<main>
  <h3 class="sh">${ICON_LIMITS}Limits</h3>
${rows || empty}
${renderChart(snap.days, now, offsetHours)}
${renderModels(snap.models)}
</main>`;
}
