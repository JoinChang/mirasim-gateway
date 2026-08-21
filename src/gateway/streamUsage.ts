import { cachedInputTokens, totalInputTokens, totalOutputTokens } from "../usage/tokens.js";

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /**
   * The type of an error frame seen mid-stream, if any. A response can open 200
   * and then fail — the relay bills the input, streams a while, and sends an
   * `error` event. Without this the turn books as a clean success; with it the
   * caller can record the upstream failure it actually was.
   */
  error?: string;
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
  let cached = 0;
  let error: string | undefined;

  const absorb = (u: any) => {
    if (!u || typeof u !== "object") return;
    // Anthropic repeats input on later events as 0; the real figure is the max.
    inputTokens = Math.max(inputTokens, totalInputTokens(u));
    cached = Math.max(cached, cachedInputTokens(u));
    // Output is cumulative per event, so the last non-zero report wins.
    const output = totalOutputTokens(u);
    if (output > 0) outputTokens = output;
  };

  // An Anthropic-style error frame is `{"type":"error","error":{"type":…}}`; the
  // relay may also send a bare `{"error":{…}}`. Either way the turn failed after
  // the 200 handshake. First one wins — later frames do not un-fail it.
  const noteError = (json: any) => {
    if (error !== undefined) return;
    if (json?.type === "error" || (json?.error && typeof json.error === "object")) {
      const t = json.error?.type;
      error = typeof t === "string" ? t : "error";
    }
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
      noteError(json);
      absorb(json?.usage);
      absorb(json?.message?.usage);
      absorb(json?.response?.usage);
    }
  }

  return {
    push,
    result: (): StreamUsage => ({
      inputTokens,
      outputTokens,
      cachedInputTokens: cached,
      ...(error !== undefined ? { error } : {}),
    }),
  };
}

/** An SSE comment frame — ignored by clients, never parsed as data. */
const PING = new TextEncoder().encode(": ping\n\n");

/**
 * Pass a body through untouched while metering it. `onDone` fires once the
 * upstream finishes, including when the client disconnects early.
 *
 * While the upstream is silent, a `: ping` comment is emitted every
 * `heartbeatMs` to keep the connection warm through Cloudflare's (and any
 * reverse proxy's) idle timeout, which would otherwise cut a long stream — a
 * big prefill or an extended-thinking pause — mid-response. Bedrock via the
 * relay sends no ping of its own (measured: zero keepalive frames), so this is
 * the only keepalive on the wire. The `:` lines are SSE comments, so the client
 * ignores them and they bypass the scanner — metering is untouched. The default
 * is 10s because measured mid-stream thinking pauses sit right around it (a real
 * turn showed a 14s gap). Pass `heartbeatMs = 0` to disable.
 */
export function meterStream(
  body: ReadableStream<Uint8Array>,
  onDone: (u: StreamUsage) => void,
  heartbeatMs = 10_000,
): ReadableStream<Uint8Array> {
  const scanner = createUsageScanner();
  const decoder = new TextDecoder();
  let settled = false;
  let ctrl: TransformStreamDefaultController<Uint8Array> | null = null;
  let hb: ReturnType<typeof setTimeout> | null = null;

  const disarm = () => {
    if (hb) {
      clearTimeout(hb);
      hb = null;
    }
  };
  // Re-armed on every real chunk, so a ping only fires after a genuine gap.
  const arm = () => {
    if (heartbeatMs <= 0) return;
    disarm();
    hb = setTimeout(() => {
      try {
        ctrl?.enqueue(PING);
        arm();
      } catch {
        // The readable side is gone — stop rather than ping a dead stream.
        disarm();
      }
    }, heartbeatMs);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    disarm();
    onDone(scanner.result());
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        ctrl = controller;
        arm();
      },
      transform(chunk, controller) {
        arm();
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
