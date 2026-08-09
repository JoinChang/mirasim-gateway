import { describe, expect, it } from "vitest";
import { runRound } from "../../src/keepalive/runner.js";
import type { Task } from "../../src/keepalive/tasks.js";
import { fakePool, R } from "../helpers/fakePool.js";

const task = (label: string): Task => ({ label, model: "claude-haiku-4-5", maxTokens: 64, prompt: "p" });

function scriptedPool(usage: any = { input_tokens: 5, output_tokens: 3 }) {
  const { pool, requests } = fakePool({
    respond: () => R({ content: [{ type: "text", text: "ok" }], usage }),
    accountId: (req) => req.onlyAccount ?? "pool-choice",
  });
  return { pool, requests, usage: { append: () => {} } as any };
}
const pinnedOf = (requests: Array<{ onlyAccount?: string }>) => requests.map((r) => r.onlyAccount);

describe("runRound", () => {
  it("exercises every account exactly once, pinned — the pool must not decide", async () => {
    const { pool, requests, usage } = scriptedPool();
    const { events } = await runRound({
      pool,
      usage,
      tasks: [task("a"), task("b"), task("c")],
      accountIds: ["acc1", "acc2", "acc3"],
    });
    expect(pinnedOf(requests)).toEqual(["acc1", "acc2", "acc3"]);
    expect(events.map((e) => e.accountId)).toEqual(["acc1", "acc2", "acc3"]);
  });

  it("reuses tasks when there are more accounts than tasks", async () => {
    const { pool, requests, usage } = scriptedPool();
    await runRound({ pool, usage, tasks: [task("only")], accountIds: ["acc1", "acc2", "acc3"] });
    expect(pinnedOf(requests)).toEqual(["acc1", "acc2", "acc3"]);
  });

  it("records the tokens each account actually spent", async () => {
    const { pool, usage } = scriptedPool();
    const { events } = await runRound({ pool, usage, tasks: [task("a")], accountIds: ["acc1"] });
    expect(events[0]).toMatchObject({ accountId: "acc1", inputTokens: 5, outputTokens: 3, status: 200 });
  });

  it("does nothing when there are no accounts", async () => {
    const { pool, usage, requests } = scriptedPool();
    const { events } = await runRound({ pool, usage, tasks: [task("a")], accountIds: [] });
    expect(events).toEqual([]);
    expect(pinnedOf(requests)).toEqual([]);
  });

  it("counts cached input like the rest of the gateway does", async () => {
    const { pool, usage } = scriptedPool({ input_tokens: 9, cache_read_input_tokens: 4804, output_tokens: 5 });
    const { events } = await runRound({ pool, usage, tasks: [task("a")], accountIds: ["acc1"] });
    expect(events[0]).toMatchObject({ inputTokens: 4813, outputTokens: 5 });
  });
});
