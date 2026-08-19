import { describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/device.js";
import { callUpstream } from "../../src/upstream/client.js";
import { makeSemaphore } from "../../src/upstream/sem.js";

describe("callUpstream", () => {
  it("sends genuine headers + ticket bearer + signature when signing", async () => {
    let seen: any = null;
    const fetchFn = (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: init.body };
      return new Response("{}", { status: 200 });
    }) as any;
    const id = generateIdentity();
    await callUpstream(
      { token: "TKN", ticket: "TICKET", identity: id, sem: makeSemaphore(4) },
      "/v1/messages",
      { model: "m", messages: [] },
      "messages",
      { deviceSigning: true, appVersion: "0.0.150", relayBase: "https://relay", fetchFn },
    );
    expect(seen.url).toBe("https://relay/v1/messages");
    expect(seen.headers.authorization).toBe("Bearer TICKET");
    expect(seen.headers["x-mirasim-client"]).toBe("0.0.150");
    expect(seen.headers["x-mirasim-agent"]).toBe("claude");
    expect(seen.headers["x-mirasim-session"]).toBeTruthy();
    expect(seen.headers["x-mirasim-sig"]).toBeTruthy();
    expect(seen.headers["x-mirasim-device"]).toBe(id.deviceId);
    // Not sending this is consent by default, and the prompts flowing through are
    // the downstream caller's, not ours to volunteer.
    expect(seen.headers["x-mirasim-collect"]).toBe("off");
  });
  it("uses plain token and no signature when signing off", async () => {
    let seen: any = null;
    const fetchFn = (async (_u: string, init: any) => {
      seen = init.headers;
      return new Response("{}");
    }) as any;
    await callUpstream(
      { token: "TKN", ticket: null, identity: null, sem: makeSemaphore(4) },
      "/v1/chat/completions",
      { model: "m" },
      "chat",
      { deviceSigning: false, appVersion: "0.0.150", relayBase: "https://relay", fetchFn },
    );
    expect(seen.authorization).toBe("Bearer TKN");
    expect(seen["x-mirasim-sig"]).toBeUndefined();
    expect(seen["x-mirasim-agent"]).toBe("codex");
  });

  const call = async (betas: string | undefined) => {
    let seen: any = null;
    const fetchFn = (async (_u: string, init: any) => {
      seen = init.headers;
      return new Response("{}");
    }) as any;
    await callUpstream(
      { token: "TKN", ticket: null, identity: null, sem: makeSemaphore(4) },
      "/v1/messages",
      { model: "m" },
      "messages",
      { deviceSigning: false, appVersion: "0.0.150", relayBase: "https://relay", fetchFn, betas },
    );
    return seen;
  };

  it("forwards the caller's betas, since the relay ignores unknown ones anyway", async () => {
    const seen = await call("claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14");
    expect(seen["anthropic-beta"]).toBe("claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14");
  });

  it("drops oauth-2025-04-20, the one value the app strips, and forwards the rest", async () => {
    const seen = await call("oauth-2025-04-20,context-1m-2025-08-07");
    expect(seen["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("sends no beta header when the client asked only for the dropped one", async () => {
    const seen = await call("oauth-2025-04-20");
    expect(seen["anthropic-beta"]).toBeUndefined();
  });

  it("sends no beta header when the client sent none", async () => {
    expect((await call(undefined))["anthropic-beta"]).toBeUndefined();
  });
});
