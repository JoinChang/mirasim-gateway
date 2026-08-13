import { describe, expect, it } from "vitest";
import { createPool } from "../../src/accounts/pool.js";
import { createRefresher } from "../../src/accounts/refresh.js";
import { accountStore } from "../../src/accounts/store.js";
import { createTicketManager } from "../../src/accounts/ticket.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { makeSemaphore } from "../../src/upstream/sem.js";
import { jsonResponse, mkJwt } from "../helpers/fakes.js";

/**
 * `setup` mirrors pool-execute.test.ts, but lets each leg of the call fail on
 * its own: the refresh, the device session, and the relay hop are what the
 * fall-through has to tell apart.
 */
function setup(opts: {
  accounts?: number;
  deviceSigning?: boolean;
  refresh?: () => Response;
  session?: () => Response;
  relay?: () => Response;
  relayThrows?: string;
}) {
  const db = memDb();
  const store = accountStore({ db, masterKey: null });
  for (let i = 0; i < (opts.accounts ?? 2); i++) store.add({ id: `a${i + 1}`, refreshToken: `r${i + 1}` });
  const fetchFn = (async (url: string) => {
    if (url.includes("/auth/refresh"))
      return opts.refresh?.() ?? jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) });
    if (url.includes("/v1/device/session")) return opts.session?.() ?? jsonResponse({ ticket: "T", expiresIn: 600 });
    if (opts.relayThrows) throw new Error(opts.relayThrows);
    return opts.relay?.() ?? jsonResponse({ ok: true });
  }) as any;
  const config = loadConfig({
    fileJson: {
      deviceSigning: opts.deviceSigning ?? false,
      cooldownMs: 40,
      maxWaitMs: 300,
      maxAttempts: 4,
      retry5xx: 0,
      retry5xxDelayMs: 5,
    },
    env: {},
  });
  const refresher = createRefresher({ store, loginBase: "https://login", fetchFn });
  const ticketManager = createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: config.appVersion });
  const pool = createPool({ store, refresher, ticketManager, config, sem: makeSemaphore(4), fetchFn });
  return { pool, store };
}

const body = async (r: Response) => (await r.json()) as any;

describe("pool.execute fall-through names the real failure", () => {
  it("says the refresh failed, and carries the upstream status, instead of blaming throttling", async () => {
    const { pool } = setup({ refresh: () => jsonResponse({ error: "nope" }, 401) });
    const { response } = await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" } });
    expect(response.status).toBe(429);
    const j = await body(response);
    expect(j.error.type).toBe("pool_exhausted");
    expect(j.error.message).toMatch(/refresh/);
    expect(j.error.message).toMatch(/401/);
    expect(j.error.attempts.every((a: any) => a.stage === "refresh")).toBe(true);
  });

  it("says the relay call itself threw, and quotes the transport error", async () => {
    const { pool } = setup({ relayThrows: "connect ECONNREFUSED" });
    const { response } = await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" } });
    const j = await body(response);
    expect(j.error.type).toBe("pool_exhausted");
    expect(j.error.message).toMatch(/ECONNREFUSED/);
    expect(j.error.attempts.every((a: any) => a.stage === "call")).toBe(true);
  });

  it("reports that signing ran without a ticket — a silent degradation today", async () => {
    // The device session fails, `ensure` returns null rather than throwing, and
    // the request goes out unticketed. If the relay then rejects it, the ticket
    // is the thing worth knowing about.
    const { pool } = setup({
      deviceSigning: true,
      session: () => jsonResponse({ error: "no" }, 403),
      relay: () => jsonResponse({ error: "rl" }, 429, { "retry-after": "1" }),
    });
    const { response } = await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" } });
    const j = await body(response);
    expect(j.error.attempts.some((a: any) => a.ticketMissing)).toBe(true);
    expect(j.error.message).toMatch(/without a device ticket/);
  });

  it("still says all_accounts_throttled when that is genuinely what happened", async () => {
    const { pool } = setup({ relay: () => jsonResponse({ error: "rl" }, 429, { "retry-after": "1" }) });
    const { response } = await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" } });
    expect(response.status).toBe(429);
    const j = await body(response);
    expect(j.error.type).toBe("all_accounts_throttled");
  });

  it("says there are no accounts rather than pretending they are throttled", async () => {
    const { pool } = setup({ accounts: 0 });
    const { response } = await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" } });
    const j = await body(response);
    expect(j.error.type).toBe("no_accounts");
    expect(j.error.message).toMatch(/no accounts/i);
  });
});
