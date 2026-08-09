import { describe, expect, it } from "vitest";
import type { ExecuteOptions, Pool } from "../../src/accounts/pool.js";
import { runRound } from "../../src/keepalive/runner.js";
import type { Task } from "../../src/keepalive/tasks.js";
import { R } from "../helpers/fakePool.js";

const task = (label: string): Task => ({ label, model: "claude-haiku-4-5", maxTokens: 64, prompt: "p" });

function fakePool(usage: any = { input_tokens: 5, output_tokens: 3 }) {
  const pinned: Array<string | undefined> = [];
  const pool: Pool = {
    execute: async (_k, buildAndCall, _model, options?: ExecuteOptions) => {
      pinned.push(options?.onlyAccount);
      const call = async () => R({ content: [{ type: "text", text: "ok" }], usage });
      return { response: await buildAndCall(call), accountId: options?.onlyAccount ?? "pool-choice" };
    },
    deviceIdentityFor: () => ({}) as any,
  };
  return { pool, pinned, usage: { append: () => {} } as any };
}

describe("runRound", () => {
  it("exercises every account exactly once, pinned — the pool must not decide", async () => {
    const { pool, pinned, usage } = fakePool();
    const { events } = await runRound({
      pool,
      usage,
      tasks: [task("a"), task("b"), task("c")],
      accountIds: ["acc1", "acc2", "acc3"],
    });
    expect(pinned).toEqual(["acc1", "acc2", "acc3"]);
    expect(events.map((e) => e.accountId)).toEqual(["acc1", "acc2", "acc3"]);
  });

  it("reuses tasks when there are more accounts than tasks", async () => {
    const { pool, pinned, usage } = fakePool();
    await runRound({ pool, usage, tasks: [task("only")], accountIds: ["acc1", "acc2", "acc3"] });
    expect(pinned).toEqual(["acc1", "acc2", "acc3"]);
  });

  it("records the tokens each account actually spent", async () => {
    const { pool, usage } = fakePool();
    const { events } = await runRound({ pool, usage, tasks: [task("a")], accountIds: ["acc1"] });
    expect(events[0]).toMatchObject({ accountId: "acc1", inputTokens: 5, outputTokens: 3, status: 200 });
  });

  it("does nothing when there are no accounts", async () => {
    const { pool, usage, pinned } = fakePool();
    const { events } = await runRound({ pool, usage, tasks: [task("a")], accountIds: [] });
    expect(events).toEqual([]);
    expect(pinned).toEqual([]);
  });

  it("counts cached input like the rest of the gateway does", async () => {
    const { pool, usage } = fakePool({ input_tokens: 9, cache_read_input_tokens: 4804, output_tokens: 5 });
    const { events } = await runRound({ pool, usage, tasks: [task("a")], accountIds: ["acc1"] });
    expect(events[0]).toMatchObject({ inputTokens: 4813, outputTokens: 5 });
  });
});
