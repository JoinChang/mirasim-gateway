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
  it("forwards anthropic-beta values, dropping only what the app drops", () => {
    // Measured 2026-08-19: the relay ignores anthropic-beta entirely — a bogus
    // value still returns 200 and is never echoed. So forwarding is harmless and
    // a whitelist only discards betas the caller legitimately asked for. The one
    // value the desktop client itself strips is oauth-2025-04-20.
    expect(
      filterAnthropicBeta({ "anthropic-beta": "context-1m-2025-08-07,interleaved-thinking-2025-05-14" })[
        "anthropic-beta"
      ],
    ).toBe("context-1m-2025-08-07,interleaved-thinking-2025-05-14");
    expect(filterAnthropicBeta({ "anthropic-beta": "context-1m-2025-08-07,oauth-2025-04-20" })["anthropic-beta"]).toBe(
      "context-1m-2025-08-07",
    );
    expect(filterAnthropicBeta({ "anthropic-beta": "oauth-2025-04-20" })["anthropic-beta"]).toBeUndefined();
  });
});
