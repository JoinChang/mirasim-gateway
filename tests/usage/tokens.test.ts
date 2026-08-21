import { describe, expect, it } from "vitest";
import { cachedInputTokens, totalInputTokens, totalOutputTokens, usageTotalsFrom } from "../../src/usage/tokens.js";

describe("totalInputTokens", () => {
  // Real numbers observed against the relay: a 4804-token cached system prompt
  // reports input_tokens 9. Billing the 9 undercounts the request 534x.
  it("adds cache creation to Anthropic input, which excludes it", () => {
    expect(totalInputTokens({ input_tokens: 9, cache_creation_input_tokens: 4804, cache_read_input_tokens: 0 })).toBe(
      4813,
    );
  });

  it("adds cache reads to Anthropic input", () => {
    expect(totalInputTokens({ input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 4804 })).toBe(
      4813,
    );
  });

  it("leaves an uncached Anthropic request alone", () => {
    expect(totalInputTokens({ input_tokens: 14, output_tokens: 6 })).toBe(14);
  });

  it("trusts OpenAI prompt_tokens, which already counts cached input", () => {
    expect(totalInputTokens({ prompt_tokens: 12, cache_read_input_tokens: 4804 })).toBe(12);
  });

  it("reports zero when there is no usage to read", () => {
    expect(totalInputTokens(undefined)).toBe(0);
    expect(totalInputTokens({})).toBe(0);
  });

  it("ignores non-numeric junk instead of producing NaN", () => {
    expect(totalInputTokens({ input_tokens: 5, cache_read_input_tokens: "lots" })).toBe(5);
  });
});

describe("totalOutputTokens", () => {
  it("reads either dialect", () => {
    expect(totalOutputTokens({ output_tokens: 6 })).toBe(6);
    expect(totalOutputTokens({ completion_tokens: 4 })).toBe(4);
    expect(totalOutputTokens({})).toBe(0);
  });
});

describe("cachedInputTokens", () => {
  it("reads Anthropic cache_read_input_tokens — the part served from cache", () => {
    expect(
      cachedInputTokens({ input_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 4804 }),
    ).toBe(4804);
  });
  it("reads OpenAI prompt_tokens_details.cached_tokens", () => {
    expect(cachedInputTokens({ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 320 } })).toBe(320);
  });
  it("is zero when nothing was cached or the usage is absent", () => {
    expect(cachedInputTokens({ input_tokens: 9 })).toBe(0);
    expect(cachedInputTokens(null)).toBe(0);
  });
});

describe("usageTotalsFrom", () => {
  it("counts cached input on a complete response body", () => {
    const u = usageTotalsFrom({
      usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 4804, output_tokens: 5 },
    });
    expect(u).toEqual({ inputTokens: 4813, outputTokens: 5, cachedInputTokens: 4804, webSearchRequests: 0 });
  });

  it("reads the Anthropic web search count", () => {
    expect(usageTotalsFrom({ usage: { server_tool_use: { web_search_requests: 3 } } }).webSearchRequests).toBe(3);
  });

  it("reads the OpenAI web search count", () => {
    expect(usageTotalsFrom({ usage: { web_search_requests: 2 } }).webSearchRequests).toBe(2);
  });

  it("reports zeros for a body with no usage", () => {
    expect(usageTotalsFrom(null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      webSearchRequests: 0,
    });
  });
});
