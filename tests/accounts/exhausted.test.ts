import { describe, expect, it } from "vitest";
import { type AttemptFailure, exhaustedResponse } from "../../src/accounts/exhausted.js";

const throttled = (retryAfter?: string): AttemptFailure => ({
  accountId: "acc_xxxxxxxxxxxxxxxx",
  stage: "throttled",
  status: 429,
  ...(retryAfter ? { retryAfter } : {}),
});

describe("exhaustedResponse Retry-After", () => {
  it("sets Retry-After to the longest wait any attempt reported", () => {
    // A downstream client backs off on the standard header, not on a retryAfter
    // buried in the JSON body. The shared-budget refusal carries 3600 here; the
    // caller must see it, or it retries into a wall.
    const res = exhaustedResponse([throttled("30"), throttled("3600"), throttled("5")], "max_attempts");
    expect(res.headers.get("retry-after")).toBe("3600");
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
