import { describe, expect, it } from "vitest";
import type { Outcome } from "../../src/models/classify.js";
import { reactTo } from "../../src/accounts/reaction.js";

describe("reactTo", () => {
  it("returns to the caller on success, clearing the account's fails", () => {
    expect(reactTo({ kind: "ok", fallbackTo: null })).toEqual({ flow: "return", fails: "clear" });
  });

  it("hands a dead-model 429 back to the caller without blaming the account", () => {
    // A model the relay has no deployment for is not the account's fault — cooling
    // the pool over it would take every account offline for a model that never works.
    expect(reactTo({ kind: "model_unavailable", status: 429 })).toEqual({ flow: "return", fails: "clear" });
  });

  it("returns an unclassifiable response rather than cooling anyone", () => {
    expect(reactTo({ kind: "ignored" })).toEqual({ flow: "return", fails: "clear" });
  });

  it("walks past a shared-budget refusal without cooling or blaming the account", () => {
    // The relay's own budget, not this account's window. Never cool it, never
    // count a fail — but take it out of this call's rotation and keep its words.
    expect(reactTo({ kind: "relay_exhausted", status: 429 })).toEqual({
      flow: "continue",
      fails: "clear",
      cool: false,
      refused: true,
      stage: "throttled",
    });
  });

  it("cools and blames an account the relay throttled", () => {
    expect(reactTo({ kind: "account_throttled" })).toEqual({
      flow: "continue",
      fails: "increment",
      cool: true,
      refused: false,
      stage: "throttled",
    });
  });

  it("cools, blames, and drops from rotation an account refused for entitlement", () => {
    // Will not lift on retry, but a mixed-plan pool may hold an entitled account —
    // so walk on rather than hand it straight back.
    expect(reactTo({ kind: "account_refused", reason: "entitlement", status: 403 })).toEqual({
      flow: "continue",
      fails: "increment",
      cool: true,
      refused: true,
      stage: "refused",
    });
  });
});
