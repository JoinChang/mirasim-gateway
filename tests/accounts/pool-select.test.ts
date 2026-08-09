import { describe, expect, it } from "vitest";
import { cooldownMsFrom, selectAccount } from "../../src/accounts/pool.js";

const A = (id: string, o: Partial<{ disabledUntil: number; lastUtilization: number; lastUsedAt: number }> = {}) => ({
  id,
  disabledUntil: 0,
  lastUtilization: 0,
  lastUsedAt: 0,
  ...o,
});
describe("selectAccount", () => {
  it("prefers lower utilization then LRU among enabled", () => {
    const sel = selectAccount(
      [
        A("a", { lastUtilization: 0.5, lastUsedAt: 1 }),
        A("b", { lastUtilization: 0.1, lastUsedAt: 9 }),
        A("c", { lastUtilization: 0.1, lastUsedAt: 2 }),
      ],
      100,
    );
    expect(sel?.account.id).toBe("c");
    expect(sel?.waitMs).toBe(0);
  });
  it("all cooling → soonest to thaw + waitMs", () => {
    const sel = selectAccount([A("a", { disabledUntil: 500 }), A("b", { disabledUntil: 300 })], 100);
    expect(sel?.account.id).toBe("b");
    expect(sel?.waitMs).toBe(200);
  });
  it("empty → null", () => {
    expect(selectAccount([], 0)).toBeNull();
  });
});
describe("cooldownMsFrom", () => {
  const gh = (m: Record<string, string>) => (k: string) => m[k];
  it("honors retry-after seconds (capped)", () => {
    expect(cooldownMsFrom(gh({ "retry-after": "5" }), 0, 90000)).toBe(5000);
  });
  it("uses near-term reset header", () => {
    const now = 1_000_000;
    expect(
      cooldownMsFrom(gh({ "anthropic-ratelimit-unified-5h-reset": String(((now + 60000) / 1000) | 0) }), 0, 90000, now),
    ).toBeGreaterThan(0);
  });
  it("exponential backoff fallback", () => {
    expect(cooldownMsFrom(gh({}), 2, 90000)).toBe(32000);
  });
});
