import { describe, expect, it } from "vitest";
import { createUsageScanner } from "../../src/gateway/streamUsage.js";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("createUsageScanner", () => {
  it("takes input tokens from message_start", () => {
    const s = createUsageScanner();
    s.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 1234 } } }));
    expect(s.result().inputTokens).toBe(1234);
  });

  it("takes the running output count from the last message_delta", () => {
    const s = createUsageScanner();
    s.push(sse("message_delta", { type: "message_delta", usage: { output_tokens: 10 } }));
    s.push(sse("message_delta", { type: "message_delta", usage: { output_tokens: 47 } }));
    expect(s.result().outputTokens).toBe(47);
  });

  it("survives a chunk boundary that splits a data line mid-JSON", () => {
    const s = createUsageScanner();
    const whole = sse("message_start", { type: "message_start", message: { usage: { input_tokens: 99 } } });
    const cut = Math.floor(whole.length / 2);
    s.push(whole.slice(0, cut));
    s.push(whole.slice(cut));
    expect(s.result().inputTokens).toBe(99);
  });

  it("understands the OpenAI shape too", () => {
    const s = createUsageScanner();
    s.push(`data: ${JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`);
    expect(s.result()).toEqual({ inputTokens: 20, outputTokens: 5 });
  });

  it("reports zeros when the stream carried no usage at all", () => {
    const s = createUsageScanner();
    s.push(sse("content_block_delta", { type: "content_block_delta", delta: { text: "hi" } }));
    expect(s.result()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("ignores lines that are not JSON rather than throwing", () => {
    const s = createUsageScanner();
    s.push("data: [DONE]\n\ndata: {not json\n\n");
    s.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 7 } } }));
    expect(s.result().inputTokens).toBe(7);
  });

  it("keeps the larger input count when a stream reports it more than once", () => {
    const s = createUsageScanner();
    s.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 100 } } }));
    s.push(sse("message_delta", { type: "message_delta", usage: { input_tokens: 0, output_tokens: 3 } }));
    expect(s.result()).toEqual({ inputTokens: 100, outputTokens: 3 });
  });

  it("flags a mid-stream error event, keeping the tokens already consumed", () => {
    // A 200 stream that fails partway is not a clean success: the relay opened
    // the response, billed the input, then sent an error frame. Booking it as 200
    // hides an upstream failure and counts a broken turn as served.
    const s = createUsageScanner();
    s.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 50 } } }));
    s.push(sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(s.result().error).toBe("overloaded_error");
    expect(s.result().inputTokens).toBe(50);
  });

  it("leaves error undefined for a clean stream", () => {
    const s = createUsageScanner();
    s.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }));
    expect(s.result().error).toBeUndefined();
  });

  it("counts cached input, which Anthropic reports outside input_tokens", () => {
    const s = createUsageScanner();
    s.push(
      sse("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 4804 } },
      }),
    );
    s.push(sse("message_delta", { type: "message_delta", usage: { output_tokens: 5 } }));
    expect(s.result()).toEqual({ inputTokens: 4813, outputTokens: 5 });
  });
});
