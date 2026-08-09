import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { handleMessages } from "../../src/dialects/anthropic.js";
import { fakePool, R } from "../helpers/fakePool.js";

const cfg = loadConfig({ fileJson: {}, env: {} });
const deps = (script: Array<() => Response>) => ({
  pool: fakePool({ script }).pool,
  cfg,
  search: async (q: string) => [{ url: `http://res/${q}`, title: "T", description: "D" }],
});

describe("anthropic dialect", () => {
  it("web_search: reconstructs native blocks + citations", async () => {
    const d = deps([
      () =>
        R({
          id: "m1",
          model: "claude",
          content: [
            { type: "text", text: "searching" },
            { type: "tool_use", id: "t1", name: "web_search", input: { query: "q" } },
          ],
        }),
      () => R({ id: "m2", model: "claude", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn" }),
    ]);
    const out = await handleMessages(
      d as any,
      { model: "claude", messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search_20250305" }] },
      false,
    );
    expect(out.type).toBe("json");
    const blocks = (out as any).json.content.map((b: any) => b.type);
    expect(blocks).toEqual(["text", "server_tool_use", "web_search_tool_result", "text"]);
    expect((out as any).json.usage.server_tool_use.web_search_requests).toBe(1);
    const lastText = (out as any).json.content.at(-1);
    expect(lastText.citations[0].url).toBe("http://res/q");
  });
  it("web_search + stream → synthetic SSE", async () => {
    const d = deps([() => R({ id: "m", model: "c", content: [{ type: "text", text: "a" }], stop_reason: "end_turn" })]);
    const out = await handleMessages(
      d as any,
      { model: "c", messages: [], tools: [{ type: "web_search_20250305" }] },
      true,
    );
    expect(out.type).toBe("sse");
    expect((out as any).text).toContain("event: message_start");
    expect((out as any).text).toContain("event: message_stop");
  });
  it("passthrough json when no web_search tool", async () => {
    const d = deps([() => R({ id: "m", content: [{ type: "text", text: "hi" }] })]);
    const out = await handleMessages(d as any, { model: "c", messages: [] }, false);
    expect(out.type).toBe("json");
    expect((out as any).json.content[0].text).toBe("hi");
  });
  it("passthrough stream returns upstream response to pipe", async () => {
    const d = deps([() => R({ ok: 1 })]);
    const out = await handleMessages(d as any, { model: "c", messages: [] }, true);
    expect(out.type).toBe("stream");
  });
});
