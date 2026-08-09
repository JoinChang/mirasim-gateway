import { describe, expect, it } from "vitest";
import { type DialectAdapter, runWebSearchLoop } from "../../src/websearch/loop.js";

describe("runWebSearchLoop", () => {
  it("runs search once, feeds results, finalizes", async () => {
    let toolTurnDone = false;
    const collected: string[] = [];
    const adapter: DialectAdapter = {
      kind: "messages",
      body: () => ({ n: collected.length }),
      parseToolCalls: () => (toolTurnDone ? [] : [{ id: "t1", query: "hello" }]),
      onAssistant: () => {
        toolTurnDone = true;
      },
      onToolResults: (res) => {
        for (const r of res) collected.push(...r.rows.map((x) => x.url));
      },
      finalize: () => ({ status: 200, json: { done: true, cites: collected } }),
    };
    const out = await runWebSearchLoop({
      adapter,
      hop: async () => ({ status: 200, json: {} }),
      search: async (q) => [{ url: `http://res/${q}`, title: q, description: "" }],
      maxUses: 2,
    });
    expect(out.json.done).toBe(true);
    expect(out.json.cites).toEqual(["http://res/hello"]);
  });
  it("surfaces upstream non-200 immediately", async () => {
    const adapter = {
      kind: "chat",
      body: () => ({}),
      parseToolCalls: () => [],
      onAssistant() {},
      onToolResults() {},
      finalize: () => ({ status: 200, json: {} }),
    } as DialectAdapter;
    const out = await runWebSearchLoop({
      adapter,
      hop: async () => ({ status: 429, json: { e: 1 } }),
      search: async () => [],
      maxUses: 2,
    });
    expect(out.status).toBe(429);
  });
});
