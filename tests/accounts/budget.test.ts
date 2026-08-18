import { describe, expect, it } from "vitest";
import { summarize } from "../../src/accounts/budget.js";
import type { Limits } from "../../src/accounts/limits.js";

const ok = (accountId: string, windows: Array<[string, number, number, number]>): Limits => ({
  accountId,
  state: "ok",
  suspended: false,
  unmetered: false,
  degraded: false,
  windows: windows.map(([name, usedCents, budgetCents, resetAt]) => ({ name, usedCents, budgetCents, resetAt })),
});

describe("summarize", () => {
  it("sums each window by the relay's own label, not by position", () => {
    // The max plan has three windows and plus has one. Merging positionally
    // would add a 7d budget onto the 5h line.
    const rows = summarize([
      ok("max", [
        ["5h", 74, 26096, 1000],
        ["7d", 1137, 74560, 2000],
        ["30d", 1136, 320000, 3000],
      ]),
      ok("plus", [["7d", 0, 11667, 2500]]),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["5h", "7d", "30d"]);
    expect(rows[1]).toMatchObject({ name: "7d", usedCents: 1137, budgetCents: 86227, accounts: 2 });
  });

  it("orders shortest first — the window that bites first is the one to read", () => {
    const rows = summarize([
      ok("a", [
        ["30d", 0, 3, 1],
        ["5h", 0, 1, 1],
        ["7d", 0, 2, 1],
      ]),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["5h", "7d", "30d"]);
  });

  it("reports the soonest reset, and says when they are staggered", () => {
    const rows = summarize([ok("a", [["7d", 0, 100, 5000]]), ok("b", [["7d", 0, 100, 4000]])]);
    // 4000 is when capacity starts coming back; 5000 is when the rest does.
    expect(rows[0]).toMatchObject({ resetAt: 4000, staggered: true, accounts: 2 });
  });

  it("does not call a single account staggered", () => {
    const rows = summarize([ok("a", [["7d", 0, 100, 4000]])]);
    expect(rows[0]?.staggered).toBe(false);
  });

  it("ignores accounts that failed rather than treating them as zero budget", () => {
    const rows = summarize([
      ok("a", [["7d", 50, 100, 9]]),
      { accountId: "b", state: "error", status: 401, detail: "unauthorized" },
    ]);
    expect(rows[0]).toMatchObject({ usedCents: 50, budgetCents: 100, accounts: 1 });
  });

  it("keeps an unknown window instead of dropping it, and sorts it last", () => {
    const rows = summarize([
      ok("a", [
        ["90d", 0, 1, 1],
        ["5h", 0, 1, 1],
      ]),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["5h", "90d"]);
  });

  it("returns nothing when nothing was served", () => {
    expect(summarize([])).toEqual([]);
  });
});
