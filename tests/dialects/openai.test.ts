import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { handleOpenAIChat } from "../../src/dialects/openai-chat.js";
import { handleOpenAIResponses } from "../../src/dialects/openai-responses.js";
import { fakePool, R } from "../helpers/fakePool.js";

const cfg = loadConfig({ fileJson: {}, env: {} });
const search = async (q: string) => [{ url: `http://res/${q}`, title: "T", description: "D" }];

describe("openai chat dialect", () => {
  it("web_search: annotations + usage", async () => {
    const pool = fakePool({
      script: [
        () =>
          R({
            id: "c1",
            model: "gpt",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  tool_calls: [
                    { id: "tc1", type: "function", function: { name: "web_search", arguments: '{"query":"q"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        () =>
          R({
            id: "c2",
            model: "gpt",
            choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
          }),
      ],
    }).pool;
    const out = await handleOpenAIChat(
      { pool, cfg, search } as any,
      { model: "gpt", messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search" }] },
      false,
    );
    expect(out.type).toBe("json");
    expect((out as any).json.choices[0].message.annotations[0].url_citation.url).toBe("http://res/q");
    expect((out as any).json.usage.web_search_requests).toBe(1);
  });
  it("passthrough stream returns response", async () => {
    const out = await handleOpenAIChat(
      { pool: fakePool({ script: [() => R({ ok: 1 })] }).pool, cfg, search } as any,
      { model: "gpt", messages: [] },
      true,
    );
    expect(out.type).toBe("stream");
  });
});

describe("openai responses dialect", () => {
  it("web_search: web_search_call item + annotations", async () => {
    const pool = fakePool({
      script: [
        () =>
          R({
            id: "r1",
            model: "gpt",
            output: [{ type: "function_call", call_id: "fc1", name: "web_search", arguments: '{"query":"q"}' }],
          }),
        () =>
          R({
            id: "r2",
            model: "gpt",
            output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
          }),
      ],
    }).pool;
    const out = await handleOpenAIResponses(
      { pool, cfg, search } as any,
      { model: "gpt", input: "hi", tools: [{ type: "web_search" }] },
      false,
    );
    expect(out.type).toBe("json");
    const types = (out as any).json.output.map((o: any) => o.type);
    expect(types).toContain("web_search_call");
    expect(types).toContain("message");
    const msg = (out as any).json.output.find((o: any) => o.type === "message");
    expect(msg.content[0].annotations[0].url).toBe("http://res/q");
    expect((out as any).json.usage.web_search_requests).toBe(1);
  });
  it("web_search + stream → responses SSE", async () => {
    const pool = fakePool({
      script: [
        () => R({ id: "r", model: "g", output: [{ type: "message", content: [{ type: "output_text", text: "a" }] }] }),
      ],
    }).pool;
    const out = await handleOpenAIResponses(
      { pool, cfg, search } as any,
      { model: "g", input: "hi", tools: [{ type: "web_search" }] },
      true,
    );
    expect(out.type).toBe("sse");
    expect((out as any).text).toContain("event: response.completed");
  });
});
