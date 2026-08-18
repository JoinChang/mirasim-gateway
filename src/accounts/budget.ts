import type { Limits, LimitWindow } from "./limits.js";

export interface BudgetWindow {
  /** The relay's label: "5h", "7d", "30d". */
  name: string;
  usedCents: number;
  budgetCents: number;
  /** Soonest reset among the accounts contributing to this window. */
  resetAt: number;
  /** How many accounts this window was summed from. */
  accounts: number;
  /** True when those accounts do not all reset together. */
  staggered: boolean;
}

const ORDER = ["5h", "7d", "30d"];

/**
 * One budget per window, summed across the accounts that can actually serve.
 *
 * Summing is only honest for accounts the pool would really pick: an account
 * the relay is refusing contributes budget that cannot be spent, and counting it
 * reports headroom that does not exist. Callers filter first — `usage` asks
 * `checkReachability` and passes only the accounts that answered.
 *
 * Windows are keyed by the relay's own label because plans differ: the `max`
 * account has 5h/7d/30d and the `plus` ones only 7d, so a positional merge would
 * add a 7d budget onto a 5h line.
 *
 * `resetAt` is the soonest of the contributors, not the latest — it answers "when
 * does capacity start coming back", which is what someone reads this to find out.
 * When they do not reset together `staggered` says so, because then the single
 * timestamp is only the first step of several.
 */
export function summarize(limits: Limits[]): BudgetWindow[] {
  const byName = new Map<string, { w: LimitWindow[] }>();
  for (const l of limits) {
    if (l.state !== "ok") continue;
    for (const w of l.windows) {
      const slot = byName.get(w.name) ?? { w: [] };
      slot.w.push(w);
      byName.set(w.name, slot);
    }
  }

  const out: BudgetWindow[] = [];
  for (const [name, { w }] of byName) {
    const resets = w.map((x) => x.resetAt).filter((t) => t > 0);
    out.push({
      name,
      usedCents: w.reduce((a, x) => a + x.usedCents, 0),
      budgetCents: w.reduce((a, x) => a + x.budgetCents, 0),
      resetAt: resets.length ? Math.min(...resets) : 0,
      accounts: w.length,
      staggered: new Set(resets).size > 1,
    });
  }

  // Shortest window first, which is the one that bites first. Anything the relay
  // adds later that we have no opinion about sorts after the ones we know.
  return out.sort((a, b) => {
    const ia = ORDER.indexOf(a.name);
    const ib = ORDER.indexOf(b.name);
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib) || a.name.localeCompare(b.name);
  });
}
