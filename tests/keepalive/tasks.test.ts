import { describe, expect, it } from "vitest";
import { buildTasks } from "../../src/keepalive/tasks.js";

const MODELS = ["claude-haiku-4-5", "claude-sonnet-5"];

describe("buildTasks", () => {
  it("builds a task for each piece of source material it was given", () => {
    const tasks = buildTasks({
      models: MODELS,
      gitLog: "abc1234 fix: something",
      files: { "src/a.ts": "export const a = 1;" },
    });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.every((t) => t.prompt.length > 0)).toBe(true);
  });

  it("skips work it has no material for instead of inventing it", () => {
    const tasks = buildTasks({ models: MODELS, gitLog: "", files: {} });
    expect(tasks).toEqual([]);
  });

  it("only sends work to models currently known to be usable", () => {
    const tasks = buildTasks({
      models: ["claude-haiku-4-5"],
      gitLog: "abc1234 fix: something",
      files: { "src/a.ts": "export const a = 1;" },
    });
    expect(tasks.every((t) => t.model === "claude-haiku-4-5")).toBe(true);
  });

  it("refuses to build anything when no model is usable", () => {
    expect(buildTasks({ models: [], gitLog: "x", files: { "a.ts": "y" } })).toEqual([]);
  });

  it("truncates oversized material so one big file cannot blow the token budget", () => {
    const huge = "x".repeat(200_000);
    const tasks = buildTasks({ models: MODELS, gitLog: "", files: { "src/huge.ts": huge } });
    expect(tasks[0]!.prompt.length).toBeLessThan(20_000);
  });

  it("caps output tokens on every task", () => {
    const tasks = buildTasks({ models: MODELS, gitLog: "abc", files: { "a.ts": "b" } });
    expect(tasks.every((t) => t.maxTokens > 0 && t.maxTokens <= 1000)).toBe(true);
  });
});
