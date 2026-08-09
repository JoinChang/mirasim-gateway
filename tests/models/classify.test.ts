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

  it("5xx means the model service is unavailable", () => {
    expect(classifyOutcome(503, hdrs({}))).toEqual({ kind: "model_unavailable", status: 503 });
  });

  it("ordinary 4xx says nothing about the model or the account", () => {
    expect(classifyOutcome(400, hdrs({}))).toEqual({ kind: "ignored" });
  });
});
