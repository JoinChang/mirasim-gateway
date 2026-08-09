export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Pull token counts out of an SSE body as it streams past.
 *
 * Streamed responses used to be metered as zero, which silently exempted every
 * streaming client — Claude Code always streams — from downstream key quotas.
 * The counts are already in the stream: Anthropic reports input on
 * `message_start` and a running output total on each `message_delta`; OpenAI
 * puts both on a final chunk. Chunks split at arbitrary byte offsets, so a
 * partial trailing line is held back until the rest of it arrives.
 */
export function createUsageScanner() {
  let pending = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const absorb = (u: any) => {
    if (!u || typeof u !== "object") return;
    const input = u.input_tokens ?? u.prompt_tokens;
    const output = u.output_tokens ?? u.completion_tokens;
    // Anthropic repeats input on later events as 0; the real figure is the max.
    if (typeof input === "number") inputTokens = Math.max(inputTokens, input);
    // Output is cumulative per event, so the last non-zero report wins.
    if (typeof output === "number" && output > 0) outputTokens = output;
  };

  function push(chunk: string): void {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      absorb(json?.usage);
      absorb(json?.message?.usage);
      absorb(json?.response?.usage);
    }
  }

  return { push, result: (): StreamUsage => ({ inputTokens, outputTokens }) };
}

/**
 * Pass a body through untouched while metering it. `onDone` fires once the
 * upstream finishes, including when the client disconnects early.
 */
export function meterStream(
  body: ReadableStream<Uint8Array>,
  onDone: (u: StreamUsage) => void,
): ReadableStream<Uint8Array> {
  const scanner = createUsageScanner();
  const decoder = new TextDecoder();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    onDone(scanner.result());
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          scanner.push(decoder.decode(chunk, { stream: true }));
        } catch {
          // Metering must never break the response the client is reading.
        }
        controller.enqueue(chunk);
      },
      flush: finish,
      cancel: finish,
    }),
  );
}
