import { describe, expect, it } from "vitest";
import { type ModelChoice, selectModels } from "../../src/keepalive/tasks.js";

const rows: ModelChoice[] = [
  { model: "claude-opus-5", state: "ok" },
  { model: "claude-haiku-4-5", state: "unknown" },
  { model: "claude-opus-4-8", state: "ok", servedModel: "claude-sonnet-5" },
  { model: "claude-sonnet-4", state: "unavailable" },
  { model: "gpt-5.6-sol", state: "ok" },
];

describe("selectModels", () => {
  it("runs a model with no verdict — the round is how the verdict gets made", () => {
    // Requiring "ok" deadlocked: an outage stops the prober forming verdicts,
    // so a model reset to unknown never becomes usable and a round pinned to it
    // never runs.
    expect(selectModels(rows, ["claude-haiku-4-5"])).toEqual(["claude-haiku-4-5"]);
  });

  it("refuses a model the relay has no deployment for", () => {
    expect(selectModels(rows, ["claude-sonnet-4"])).toEqual([]);
  });

  it("refuses a model LiteLLM silently serves as something else", () => {
    expect(selectModels(rows, ["claude-opus-4-8"])).toEqual([]);
  });

  it("ignores non-claude models even when they are fine", () => {
    expect(selectModels(rows, null)).not.toContain("gpt-5.6-sol");
  });

  it("without a pin, offers every usable model", () => {
    expect(selectModels(rows, null)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });
});
