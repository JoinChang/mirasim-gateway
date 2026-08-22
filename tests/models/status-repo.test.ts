import { beforeEach, describe, expect, it } from "vitest";
import { memDb } from "../../src/db/client.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";

let repo: ReturnType<typeof modelStatusRepo>;
beforeEach(() => {
  repo = modelStatusRepo(memDb());
});

describe("modelStatusRepo", () => {
  it("knows nothing about a model it has never seen", () => {
    expect(repo.get("claude-opus-5")).toBeUndefined();
  });

  it("markOk records the success and when it happened", () => {
    repo.markOk("claude-opus-5", 1000, null);
    const row = repo.get("claude-opus-5")!;
    expect(row.state).toBe("ok");
    expect(row.lastOkAt).toBe(1000);
    expect(row.lastCheckedAt).toBe(1000);
    expect(row.servedModel).toBeNull();
  });

  it("markOk records which model was actually served on a litellm fallback", () => {
    repo.markOk("anthropic/claude-opus-4-8", 1000, "claude-sonnet-5");
    expect(repo.get("anthropic/claude-opus-4-8")!.servedModel).toBe("claude-sonnet-5");
  });

  it("markUnavailable records the status and counts the failure", () => {
    repo.markUnavailable("gpt-5.6-sol", 2000, 429);
    const row = repo.get("gpt-5.6-sol")!;
    expect(row.state).toBe("unavailable");
    expect(row.lastStatus).toBe(429);
    expect(row.lastCheckedAt).toBe(2000);
    expect(row.consecutiveFails).toBe(1);
  });

  it("repeated failures accumulate", () => {
    repo.markUnavailable("gpt-5.6-sol", 2000, 429);
    repo.markUnavailable("gpt-5.6-sol", 3000, 503);
    const row = repo.get("gpt-5.6-sol")!;
    expect(row.consecutiveFails).toBe(2);
    expect(row.lastStatus).toBe(503);
  });

  it("a later success clears an earlier failure", () => {
    repo.markUnavailable("claude-opus-5", 2000, 429);
    repo.markOk("claude-opus-5", 4000, null);
    const row = repo.get("claude-opus-5")!;
    expect(row.state).toBe("ok");
    expect(row.consecutiveFails).toBe(0);
  });

  it("clear resets an unavailable verdict back to unknown so the gate stops blocking it", () => {
    repo.markUnavailable("claude-opus-5", 2000, 504);
    repo.clear("claude-opus-5");
    const row = repo.get("claude-opus-5")!;
    expect(row.state).toBe("unknown");
    expect(row.consecutiveFails).toBe(0);
  });

  it("seed adds unseen models as unknown and leaves known verdicts alone", () => {
    repo.markUnavailable("gpt-5.6-sol", 2000, 429);
    repo.seed(["gpt-5.6-sol", "claude-opus-5"]);
    expect(repo.get("gpt-5.6-sol")!.state).toBe("unavailable");
    expect(repo.get("claude-opus-5")!.state).toBe("unknown");
    expect(repo.get("claude-opus-5")!.lastCheckedAt).toBe(0);
  });

  it("lists every model it knows", () => {
    repo.seed(["a", "b"]);
    expect(
      repo
        .list()
        .map((r) => r.model)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
