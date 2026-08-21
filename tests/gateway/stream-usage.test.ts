import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageScanner, meterStream, type StreamUsage } from "../../src/gateway/streamUsage.js";

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
    expect(s.result()).toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 });
  });

  it("reports zeros when the stream carried no usage at all", () => {
    const s = createUsageScanner();
    s.push(sse("content_block_delta", { type: "content_block_delta", delta: { text: "hi" } }));
    expect(s.result()).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
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
    expect(s.result()).toEqual({ inputTokens: 100, outputTokens: 3, cachedInputTokens: 0 });
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
    expect(s.result()).toEqual({ inputTokens: 4813, outputTokens: 5, cachedInputTokens: 4804 });
  });
});

describe("meterStream heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A source we can feed and close by hand, to control when the "relay" is silent.
  function controllable() {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    return { stream, push: (s: string) => ctrl.enqueue(enc.encode(s)), close: () => ctrl.close() };
  }

  function collect(rs: ReadableStream<Uint8Array>) {
    const out: string[] = [];
    const dec = new TextDecoder();
    const reader = rs.getReader();
    const done = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        out.push(dec.decode(r.value));
      }
    })();
    return { out, done };
  }

  it("injects a `: ping` comment once the relay goes silent past the interval", async () => {
    vi.useFakeTimers();
    const src = controllable();
    const usage: StreamUsage[] = [];
    const { out, done } = collect(meterStream(src.stream, (u) => usage.push(u), 15_000));

    src.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 1000 } } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(out.join("")).not.toContain(": ping"); // still flowing → no ping yet

    await vi.advanceTimersByTimeAsync(15_000); // silence past the interval
    expect(out.join("")).toContain(": ping");

    src.close();
    await done;
    // The ping bypasses metering entirely — the token count is untouched.
    expect(usage[0]!.inputTokens).toBe(1000);
  });

  it("does not ping while chunks keep arriving within the interval", async () => {
    vi.useFakeTimers();
    const src = controllable();
    const { out, done } = collect(meterStream(src.stream, () => {}, 15_000));

    for (let i = 0; i < 4; i++) {
      src.push(sse("message_delta", { type: "message_delta", usage: { output_tokens: i } }));
      await vi.advanceTimersByTimeAsync(10_000); // each < interval, and each resets the timer
    }
    expect(out.join("")).not.toContain(": ping");

    src.close();
    await done;
  });

  it("stops pinging once the stream ends", async () => {
    vi.useFakeTimers();
    const src = controllable();
    const { out, done } = collect(meterStream(src.stream, () => {}, 15_000));
    src.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }));
    src.close();
    await done;
    const before = out.join("");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(out.join("")).toBe(before); // no pings after the stream closed
  });

  it("stays inert when the heartbeat is disabled", async () => {
    vi.useFakeTimers();
    const src = controllable();
    const { out, done } = collect(meterStream(src.stream, () => {}, 0));
    src.push(sse("message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(out.join("")).not.toContain(": ping");
    src.close();
    await done;
  });
});
