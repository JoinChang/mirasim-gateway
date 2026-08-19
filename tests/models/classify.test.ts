import { describe, expect, it } from "vitest";
import { classifyOutcome } from "../../src/models/classify.js";

const hdrs =
  (h: Record<string, string>) =>
  (k: string): string | null =>
    h[k.toLowerCase()] ?? null;

describe("classifyOutcome", () => {
  it("200 with no litellm headers is ok with no fallback", () => {
    expect(classifyOutcome(200, hdrs({}))).toEqual({ kind: "ok", fallbackTo: null });
  });

  it("200 after a litellm fallback reports the model actually served", () => {
    const h = hdrs({ "x-litellm-attempted-fallbacks": "1", "x-litellm-model-group": "claude-sonnet-5" });
    expect(classifyOutcome(200, h)).toEqual({ kind: "ok", fallbackTo: "claude-sonnet-5" });
  });

  it("429 at low utilization with no retry-after means the model has no deployment", () => {
    const h = hdrs({ "anthropic-ratelimit-unified-7d-utilization": "0.004" });
    expect(classifyOutcome(429, h)).toEqual({ kind: "model_unavailable", status: 429 });
  });

  it("429 carrying retry-after is the account being throttled, not the model", () => {
    const h = hdrs({ "retry-after": "30", "anthropic-ratelimit-unified-7d-utilization": "0.004" });
    expect(classifyOutcome(429, h)).toEqual({ kind: "account_throttled" });
  });

  it("429 at high utilization is the account being throttled", () => {
    const h = hdrs({ "anthropic-ratelimit-unified-5h-utilization": "0.97" });
    expect(classifyOutcome(429, h)).toEqual({ kind: "account_throttled" });
  });

  it("a 429 naming any quota word is the relay's budget, not this model", () => {
    // The client matches a family here, not two literals: usage_limit and
    // quota_exceeded are the same refusal wearing a different word, and reading
    // them as a model verdict marks a working model dead for the whole pool.
    const h = hdrs({ "anthropic-ratelimit-unified-7d-utilization": "0.004" });
    for (const errorType of ["credit_exhausted_shared", "usage_limit", "insufficient_quota", "quota_exceeded"])
      expect(classifyOutcome(429, h, { errorType })).toEqual({ kind: "relay_exhausted", status: 429 });
  });

  it("a 429 naming a rate limit is the account, even with the quota untouched", () => {
    // `rate_limited` is the third name 0.0.208 knows for a 429 and it arrives
    // without retry-after. Falling through to model_unavailable would blame the
    // model for a throttle.
    const h = hdrs({ "anthropic-ratelimit-unified-7d-utilization": "0.004" });
    expect(classifyOutcome(429, h, { errorType: "rate_limited" })).toEqual({ kind: "account_throttled" });
  });

  it("5xx means the model service is unavailable", () => {
    expect(classifyOutcome(503, hdrs({}))).toEqual({ kind: "model_unavailable", status: 503 });
  });

  it("ordinary 4xx says nothing about the model or the account", () => {
    expect(classifyOutcome(400, hdrs({}))).toEqual({ kind: "ignored" });
  });

  it("403 naming a plan or an entitlement names the account, rather than staying silent", () => {
    // The client reads entitlement off a 403's message, not off a 429's type.
    // Left as `ignored`, an account with no entitlement looks like a request that
    // merely failed, and the pool learns nothing from walking past it.
    for (const errorMessage of ["your plan does not include this model", "no entitlement for this route"])
      expect(classifyOutcome(403, hdrs({}), { errorMessage })).toEqual({
        kind: "account_refused",
        reason: "entitlement",
        status: 403,
      });
  });

  it("403 naming nothing recognisable is still ignored", () => {
    expect(classifyOutcome(403, hdrs({}), { errorMessage: "forbidden" })).toEqual({ kind: "ignored" });
  });
});
