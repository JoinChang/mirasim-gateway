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

  it("sums token usage across every hop, not just the last one", async () => {
    // A search loop makes several upstream calls. Reporting only the final hop
    // silently discarded the tokens the earlier ones cost.
    let hops = 0;
    const adapter = {
      kind: "messages",
      body: () => ({}),
      parseToolCalls: () => (hops < 2 ? [{ id: "t", query: "q" }] : []),
      onAssistant() {},
      onToolResults() {},
      finalize: (r: any) => ({ status: 200, json: r }),
    } as DialectAdapter;
    const out = await runWebSearchLoop({
      adapter,
      hop: async () => {
        hops++;
        return { status: 200, json: { usage: { input_tokens: 100, output_tokens: 10 } }, accountId: `acc${hops}` };
      },
      search: async () => [],
      maxUses: 5,
    });
    expect(hops).toBe(2);
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it("counts cached input in the per-hop totals", async () => {
    const adapter = {
      kind: "messages",
      body: () => ({}),
      parseToolCalls: () => [],
      onAssistant() {},
      onToolResults() {},
      finalize: (r: any) => ({ status: 200, json: r }),
    } as DialectAdapter;
    const out = await runWebSearchLoop({
      adapter,
      hop: async () => ({
        status: 200,
        json: { usage: { input_tokens: 9, cache_read_input_tokens: 4804, output_tokens: 5 } },
        accountId: "a1",
      }),
      search: async () => [],
      maxUses: 1,
    });
    expect(out.usage).toEqual({ inputTokens: 4813, outputTokens: 5 });
  });

  it("reports which account served the answer", async () => {
    let hops = 0;
    const adapter = {
      kind: "messages",
      body: () => ({}),
      parseToolCalls: () => (hops < 2 ? [{ id: "t", query: "q" }] : []),
      onAssistant() {},
      onToolResults() {},
      finalize: () => ({ status: 200, json: {} }),
    } as DialectAdapter;
    const out = await runWebSearchLoop({
      adapter,
      hop: async () => {
        hops++;
        return { status: 200, json: {}, accountId: `acc${hops}` };
      },
      search: async () => [],
      maxUses: 5,
    });
    expect(out.accountId).toBe("acc2");
  });

  it("carries the account through on an upstream failure too", async () => {
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
      hop: async () => ({ status: 429, json: { e: 1 }, accountId: "a9" }),
      search: async () => [],
      maxUses: 2,
    });
    expect(out.status).toBe(429);
    expect(out.accountId).toBe("a9");
  });
});
