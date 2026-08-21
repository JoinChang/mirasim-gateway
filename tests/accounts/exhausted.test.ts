import { describe, expect, it } from "vitest";
import { type AttemptFailure, exhaustedResponse } from "../../src/accounts/exhausted.js";

const throttled = (retryAfter?: string): AttemptFailure => ({
  accountId: "acc_xxxxxxxxxxxxxxxx",
  stage: "throttled",
  status: 429,
  ...(retryAfter ? { retryAfter } : {}),
});

describe("exhaustedResponse Retry-After", () => {
  it("caps Retry-After so the caller retries soon, not after the relay's raw wait", () => {
    // The client honours Retry-After (Anthropic SDK does), so a raw 3600 would
    // freeze it for an hour — and even 60 is longer than useful, since the pool
    // recovers gradually and a nearby account may already be free. Cap it low so
    // the client retries soon; the relay's real figure stays in the body.
    const res = exhaustedResponse([throttled("30"), throttled("3600"), throttled("5")], "max_attempts");
    expect(res.headers.get("retry-after")).toBe("10");
  });

  it("uses the reported wait when it is already below the cap", () => {
    const res = exhaustedResponse([throttled("6")], "max_attempts");
    expect(res.headers.get("retry-after")).toBe("6");
  });

  it("sends no Retry-After when no attempt reported one", () => {
    const res = exhaustedResponse([throttled(), throttled()], "max_attempts");
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("ignores an unparseable retry-after rather than emitting garbage", () => {
    const res = exhaustedResponse([throttled("soon")], "max_attempts");
    expect(res.headers.get("retry-after")).toBeNull();
  });
});
