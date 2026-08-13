import { describe, expect, it } from "vitest";
import { createTicketManager } from "../../src/accounts/ticket.js";
import { generateIdentity } from "../../src/crypto/device.js";
import { jsonResponse } from "../helpers/fakes.js";

describe("ticket manager", () => {
  it("mints and caches a ticket", async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      expect(url).toContain("/v1/device/session");
      return jsonResponse({ ticket: "TK", expiresIn: 600 });
    }) as any;
    const tm = createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: "0.0.150" });
    const id = generateIdentity();
    expect(await tm.ensure("u", "issuer", id)).toBe("TK");
    expect(await tm.ensure("u", "issuer", id)).toBe("TK"); // cached
    expect(calls).toBe(1);
  });
  it("marks unsupported on 404 and returns null", async () => {
    const fetchFn = (async () => new Response("no", { status: 404 })) as any;
    const tm = createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: "0.0.150" });
    expect(await tm.ensure("u", "issuer", generateIdentity())).toBeNull();
  });
});
