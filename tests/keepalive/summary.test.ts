import { describe, expect, it } from "vitest";
import { summarizeRound } from "../../src/keepalive/summary.js";

const ev = (accountId: string, inputTokens: number, outputTokens: number, status = 200, latencyMs = 1000) => ({
  accountId,
  model: "claude-haiku-4-5",
  inputTokens,
  outputTokens,
  status,
  latencyMs,
});

describe("summarizeRound", () => {
  it("totals tokens per account", () => {
    const s = summarizeRound([ev("a1", 100, 50), ev("a1", 200, 60), ev("a2", 10, 5)]);
    expect(s.perAccount.a1).toMatchObject({ requests: 2, inputTokens: 300, outputTokens: 110, failures: 0 });
    expect(s.perAccount.a2).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("counts non-2xx responses as failures", () => {
    const s = summarizeRound([ev("a1", 0, 0, 429), ev("a1", 100, 50, 200)]);
    expect(s.perAccount.a1!.failures).toBe(1);
  });

  it("reports the round total so a budget can be checked against it", () => {
    const s = summarizeRound([ev("a1", 100, 50), ev("a2", 200, 100)]);
    expect(s.totalTokens).toBe(450);
  });

  it("names the accounts that never got exercised", () => {
    const s = summarizeRound([ev("a1", 1, 1)], ["a1", "a2", "a3"]);
    expect(s.untouched).toEqual(["a2", "a3"]);
  });

  it("has nothing to report on an empty round", () => {
    const s = summarizeRound([]);
    expect(s.totalTokens).toBe(0);
    expect(s.perAccount).toEqual({});
  });
});
