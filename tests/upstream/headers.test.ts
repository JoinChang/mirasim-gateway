import { describe, expect, it } from "vitest";
import { filterAnthropicBeta, sanitizeHeader, stripHopByHop } from "../../src/upstream/headers.js";

describe("headers", () => {
  it("percent-encodes non-ascii", () => {
    expect(sanitizeHeader("café")).toBe("caf%C3%A9");
    expect(sanitizeHeader("ok")).toBe("ok");
  });
  it("strips hop-by-hop", () => {
    expect(stripHopByHop({ Host: "x", "X-Keep": "y" })).toEqual({ "x-keep": "y" });
  });
  it("filters anthropic-beta to kept set", () => {
    expect(filterAnthropicBeta({ "anthropic-beta": "context-1m-2025-08-07,other" })["anthropic-beta"]).toBe(
      "context-1m-2025-08-07",
    );
    expect(filterAnthropicBeta({ "anthropic-beta": "other" })["anthropic-beta"]).toBeUndefined();
  });
});
