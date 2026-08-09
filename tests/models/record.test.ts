import { beforeEach, describe, expect, it } from "vitest";
import { memDb } from "../../src/db/client.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";
import { recordOutcome } from "../../src/models/record.js";

let repo: ReturnType<typeof modelStatusRepo>;
beforeEach(() => {
  repo = modelStatusRepo(memDb());
});

describe("recordOutcome", () => {
  it("stores a success", () => {
    recordOutcome(repo, "claude-opus-5", { kind: "ok", fallbackTo: null }, 500);
    expect(repo.get("claude-opus-5")!.state).toBe("ok");
  });

  it("stores which model a fallback actually served", () => {
    recordOutcome(repo, "anthropic/claude-opus-4-8", { kind: "ok", fallbackTo: "claude-sonnet-5" }, 500);
    expect(repo.get("anthropic/claude-opus-4-8")!.servedModel).toBe("claude-sonnet-5");
  });

  it("stores a model-level rejection", () => {
    recordOutcome(repo, "gpt-5.6-sol", { kind: "model_unavailable", status: 429 }, 500);
    const row = repo.get("gpt-5.6-sol")!;
    expect(row.state).toBe("unavailable");
    expect(row.lastStatus).toBe(429);
  });

  it("says nothing about the model when it was the account that got throttled", () => {
    recordOutcome(repo, "claude-opus-5", { kind: "account_throttled" }, 500);
    expect(repo.get("claude-opus-5")).toBeUndefined();
  });

  it("says nothing about the model on an ordinary client error", () => {
    recordOutcome(repo, "claude-opus-5", { kind: "ignored" }, 500);
    expect(repo.get("claude-opus-5")).toBeUndefined();
  });

  it("does not let an account throttle erase a known-good verdict", () => {
    recordOutcome(repo, "claude-opus-5", { kind: "ok", fallbackTo: null }, 500);
    recordOutcome(repo, "claude-opus-5", { kind: "account_throttled" }, 600);
    expect(repo.get("claude-opus-5")!.state).toBe("ok");
  });
});
