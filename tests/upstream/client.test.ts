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
      { deviceSigning: true, appVersion: "0.0.149", relayBase: "https://relay", fetchFn },
    );
    expect(seen.url).toBe("https://relay/v1/messages");
    expect(seen.headers.authorization).toBe("Bearer TICKET");
    expect(seen.headers["x-mirasim-client"]).toBe("0.0.149");
    expect(seen.headers["x-mirasim-agent"]).toBe("claude");
    expect(seen.headers["x-mirasim-session"]).toBeTruthy();
    expect(seen.headers["x-mirasim-sig"]).toBeTruthy();
    expect(seen.headers["x-mirasim-device"]).toBe(id.deviceId);
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
      { deviceSigning: false, appVersion: "0.0.149", relayBase: "https://relay", fetchFn },
    );
    expect(seen.authorization).toBe("Bearer TKN");
    expect(seen["x-mirasim-sig"]).toBeUndefined();
    expect(seen["x-mirasim-agent"]).toBe("codex");
  });
});
