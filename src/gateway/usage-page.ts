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

export interface DailyStat {
  day: string;
  requests: number;
  ok: number;
  inputTokens: number;
  cachedInputTokens: number;
  latencyMsTotal: number;
}

export interface UsageSnapshot {
  windows: BudgetWindow[];
  serving: number;
  total: number;
  days: DailyTokens[];
  models: ModelTokens[];
  statsByDay?: DailyStat[];
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
  listStats: (sinceMs: number) => DailyStat[] = () => [],
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
    const statsByDay = listStats(since);
    return { windows, serving: serving.length, total: ids.length, days, models, statsByDay, takenAt: now };
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
/**
 * A compact strip of headline numbers for the whole window: how much traffic,
 * how much of it succeeded, how much input came from cache (Claude Code leans on
 * prompt caching, so this runs high), and how slow the average turn was. Omitted
 * when there was no traffic — an empty strip says less than no strip.
 */
const ICON_TRAFFIC = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 9h3l2-5 3 10 2-6h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

/**
 * A 14-point series as an inline sparkline: a smoothed line (Catmull-Rom control
 * points), a soft area fill beneath it, and a dot on the latest point. Min-max
 * normalized into a padded band so peaks and troughs are never clipped; a flat
 * series sits mid. Self-contained SVG — no Chart.js.
 */
function sparkline(values: number[]): string {
  const n = values.length;
  if (n < 2) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pt = (i: number): [number, number] => {
    // A flat series has no range to normalize, so it sits mid rather than at the
    // floor; otherwise map into a padded band, y in [3, 18].
    const frac = max === min ? 0.5 : (values[i]! - min) / (max - min);
    return [(i / (n - 1)) * 100, 18 - frac * 15];
  };
  const pts = values.map((_, i) => pt(i));
  let d = `M ${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [p0x, p0y] = pts[i - 1] ?? pts[i]!;
    const [p1x, p1y] = pts[i]!;
    const [p2x, p2y] = pts[i + 1]!;
    const [p3x, p3y] = pts[i + 2] ?? pts[i + 1]!;
    const c1x = p1x + (p2x - p0x) / 6;
    const c1y = p1y + (p2y - p0y) / 6;
    const c2x = p2x - (p3x - p1x) / 6;
    const c2y = p2y - (p3y - p1y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2x.toFixed(1)} ${p2y.toFixed(1)}`;
  }
  const [lx, ly] = pts[n - 1]!;
  return `<svg class="spk" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><path class="spk-a" d="${d} L 100 20 L 0 20 Z"/><path class="spk-l" d="${d}"/><circle class="spk-d" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="1.6"/></svg>`;
}

const ZERO_DAY = { requests: 0, ok: 0, inputTokens: 0, cachedInputTokens: 0, latencyMsTotal: 0 };

/**
 * The traffic section: four numbers over the window — requests, success rate,
 * cache-hit rate (Claude Code leans on prompt caching, so it runs high), average
 * latency — each with a 14-day sparkline of its own trend. Totals and trends are
 * both derived from the per-day rows. Omitted when nothing ran.
 */
function renderStats(statsByDay: DailyStat[] | undefined, now: number, offsetHours: number): string {
  if (!statsByDay || statsByDay.length === 0) return "";
  const byDay = new Map(statsByDay.map((d) => [d.day, d]));
  const series: DailyStat[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86400_000, offsetHours);
    series.push({ day, ...(byDay.get(day) ?? ZERO_DAY) });
  }
  const t = series.reduce(
    (a, d) => ({
      requests: a.requests + d.requests,
      ok: a.ok + d.ok,
      inputTokens: a.inputTokens + d.inputTokens,
      cachedInputTokens: a.cachedInputTokens + d.cachedInputTokens,
      latencyMsTotal: a.latencyMsTotal + d.latencyMsTotal,
    }),
    { ...ZERO_DAY },
  );
  if (t.requests === 0) return "";
  const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
  const avg = t.latencyMsTotal / t.requests;
  const latStr = avg < 1000 ? `${Math.round(avg)}ms` : `${(avg / 1000).toFixed(1)}s`;
  const tile = (label: string, value: string, values: number[]) =>
    `<div class="stt"><span class="stv">${value}</span>${sparkline(values)}<span class="stl">${label}</span></div>`;
  return `<section class="tr">
  <h3 class="sh">${ICON_TRAFFIC}Traffic</h3>
  <div class="st">
  ${tile(
    "Requests",
    fmtTokens(t.requests),
    series.map((d) => d.requests),
  )}
  ${tile(
    "Success",
    rate(t.ok, t.requests),
    series.map((d) => (d.requests > 0 ? d.ok / d.requests : 0)),
  )}
  ${tile(
    "Cache hit",
    rate(t.cachedInputTokens, t.inputTokens),
    series.map((d) => (d.inputTokens > 0 ? d.cachedInputTokens / d.inputTokens : 0)),
  )}
  ${tile(
    "Avg latency",
    latStr,
    series.map((d) => (d.requests > 0 ? d.latencyMsTotal / d.requests : 0)),
  )}
  </div>
</section>`;
}

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
.st{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem}
.stt{display:flex;flex-direction:column;gap:.2rem;min-width:0}
.stv{font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums}
.stl{font-size:.72rem;color:var(--dim);letter-spacing:.02em}
.spk{width:100%;height:20px;display:block;overflow:visible}
.spk-l{fill:none;stroke:var(--fill);stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}
.spk-a{fill:var(--fill);opacity:.12;stroke:none}
.spk-d{fill:var(--fill)}
.sm{font-size:.85rem;margin:0}
</style>
<main>
  <h3 class="sh">${ICON_LIMITS}Limits</h3>
${rows || empty}
${renderStats(snap.statsByDay, now, offsetHours)}
${renderChart(snap.days, now, offsetHours)}
${renderModels(snap.models)}
</main>`;
}
