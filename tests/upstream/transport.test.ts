import { describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/device.js";
import { makeSemaphore } from "../../src/upstream/sem.js";
import { createRelayTransport } from "../../src/upstream/transport.js";

/** A transport whose fetch records the one outgoing relay request. */
const seenBy = (cfg: { deviceSigning: boolean }) => {
  let seen: any = null;
  const fetchFn = (async (url: string, init: any) => {
    seen = { url, headers: init.headers, body: init.body };
    return new Response("{}", { status: 200 });
  }) as any;
  const transport = createRelayTransport({
    relayBase: "https://relay",
    appVersion: "0.0.150",
    deviceSigning: cfg.deviceSigning,
    fetchFn,
    sem: makeSemaphore(4),
  });
  return { transport, seen: () => seen };
};

describe("createRelayTransport", () => {
  it("sends genuine headers + ticket bearer + signature when signing", async () => {
    const { transport, seen } = seenBy({ deviceSigning: true });
    const id = generateIdentity();
    await transport.send({
      pathname: "/v1/messages",
      kind: "messages",
      body: { model: "m", messages: [] },
      token: "TKN",
      ticket: "TICKET",
      identity: id,
    });
    const s = seen();
    expect(s.url).toBe("https://relay/v1/messages");
    expect(s.headers.authorization).toBe("Bearer TICKET");
    expect(s.headers["x-mirasim-client"]).toBe("0.0.150");
    expect(s.headers["x-mirasim-agent"]).toBe("claude");
    expect(s.headers["x-mirasim-session"]).toBeTruthy();
    expect(s.headers["x-mirasim-sig"]).toBeTruthy();
    expect(s.headers["x-mirasim-device"]).toBe(id.deviceId);
    // Not sending this is consent by default, and the prompts flowing through are
    // the downstream caller's, not ours to volunteer.
    expect(s.headers["x-mirasim-collect"]).toBe("off");
  });

  it("uses a plain token and no signature when signing is off", async () => {
    const { transport, seen } = seenBy({ deviceSigning: false });
    await transport.send({
      pathname: "/v1/chat/completions",
      kind: "chat",
      body: { model: "m" },
      token: "TKN",
      ticket: null,
      identity: null,
    });
    const h = seen().headers;
    expect(h.authorization).toBe("Bearer TKN");
    expect(h["x-mirasim-sig"]).toBeUndefined();
    expect(h["x-mirasim-agent"]).toBe("codex");
  });

  const betaHeaders = async (betas: string | undefined) => {
    const { transport, seen } = seenBy({ deviceSigning: false });
    await transport.send({
      pathname: "/v1/messages",
      kind: "messages",
      body: { model: "m" },
      token: "TKN",
      ticket: null,
      identity: null,
      betas,
    });
    return seen().headers;
  };

  it("forwards the caller's betas, since the relay ignores unknown ones anyway", async () => {
    const h = await betaHeaders("claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14");
    expect(h["anthropic-beta"]).toBe("claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14");
  });

  it("drops oauth-2025-04-20, the one value the app strips, and forwards the rest", async () => {
    const h = await betaHeaders("oauth-2025-04-20,context-1m-2025-08-07");
    expect(h["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("sends no beta header when the client asked only for the dropped one", async () => {
    expect((await betaHeaders("oauth-2025-04-20"))["anthropic-beta"]).toBeUndefined();
  });

  it("sends no beta header when the client sent none", async () => {
    expect((await betaHeaders(undefined))["anthropic-beta"]).toBeUndefined();
  });
});
