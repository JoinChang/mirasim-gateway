import { describe, expect, it } from "vitest";
import { explainRelayError } from "../../src/gateway/relayErrors.js";

// The exact body the relay returns when its shared cloud budget is spent.
const exhausted = { type: "error", error: { type: "permission_error", message: "This request was not authorized." } };

describe("explainRelayError", () => {
  it("explains the relay's exhausted-capacity 403, which reads as an auth failure", () => {
    const out = explainRelayError(403, exhausted);
    expect(out).not.toBeNull();
    expect(out.error.message).toMatch(/capacity/i);
    expect(out.error.message).toMatch(/not your account/i);
  });

  it("keeps what the relay actually said, so the original is not lost", () => {
    expect(explainRelayError(403, exhausted).error.message).toContain("This request was not authorized.");
  });

  it("keeps the status-carrying shape a client expects", () => {
    const out = explainRelayError(403, exhausted);
    expect(out.type).toBe("error");
    expect(out.error.type).toBe("permission_error");
  });

  it("leaves a 403 of a different shape alone rather than guessing", () => {
    expect(
      explainRelayError(403, { type: "error", error: { type: "authentication_error", message: "bad key" } }),
    ).toBeNull();
  });

  it("leaves other statuses alone", () => {
    expect(explainRelayError(429, exhausted)).toBeNull();
    expect(explainRelayError(200, { content: [] })).toBeNull();
  });

  it("tolerates a missing or unparsed body", () => {
    expect(explainRelayError(403, null)).toBeNull();
    expect(explainRelayError(403, "nope")).toBeNull();
  });
});
