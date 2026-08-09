import { describe, expect, it } from "vitest";
import { createPool } from "../../src/accounts/pool.js";
import { createRefresher } from "../../src/accounts/refresh.js";
import { accountStore } from "../../src/accounts/store.js";
import { createTicketManager } from "../../src/accounts/ticket.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { makeSemaphore } from "../../src/upstream/sem.js";
import { jsonResponse, mkJwt } from "../helpers/fakes.js";

function setup(relayScript: Array<() => Response>) {
  const db = memDb();
  const store = accountStore({ db, masterKey: null });
  store.add({ id: "a1", refreshToken: "r1" });
  store.add({ id: "a2", refreshToken: "r2" });
  const fetchFn = (async (url: string) => {
    if (url.includes("/auth/refresh"))
      return jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) });
    const next = relayScript.shift();
    return next ? next() : jsonResponse({ ok: true });
  }) as any;
  const config = loadConfig({
    fileJson: { deviceSigning: false, cooldownMs: 40, maxWaitMs: 300, maxAttempts: 6, retry5xx: 2, retry5xxDelayMs: 5 },
    env: {},
  });
  const refresher = createRefresher({ store, loginBase: "https://login", fetchFn });
  const ticketManager = createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: config.appVersion });
  const pool = createPool({ store, refresher, ticketManager, config, sem: makeSemaphore(4), fetchFn });
  return { pool, store };
}

describe("pool.execute failover", () => {
  it("returns 200 directly", async () => {
    const { pool } = setup([() => jsonResponse({ ok: 1 })]);
    const { response, accountId } = await pool.execute("messages", (call) => call("/v1/messages", { model: "m" }));
    expect(response.status).toBe(200);
    expect(accountId).toBeTruthy();
  });

  it("429 cools the account and fails over to the next", async () => {
    const { pool, store } = setup([
      () => jsonResponse({ error: "rl" }, 429, { "retry-after": "1" }),
      () => jsonResponse({ ok: 2 }, 200),
    ]);
    const { response } = await pool.execute("messages", (call) => call("/v1/messages", { model: "m" }));
    expect(response.status).toBe(200);
    // one account got cooled
    const cooled = store.list().filter((a) => a.disabledUntil > Date.now());
    expect(cooled.length).toBe(1);
  });

  it("5xx retries without cooling, then succeeds", async () => {
    const { pool, store } = setup([
      () => jsonResponse({ e: 1 }, 500),
      () => jsonResponse({ e: 2 }, 502),
      () => jsonResponse({ ok: 3 }, 200),
    ]);
    const { response } = await pool.execute("chat", (call) => call("/v1/chat/completions", { model: "m" }));
    expect(response.status).toBe(200);
    // no account should be in cooldown (5xx does not cool)
    expect(store.list().every((a) => a.disabledUntil <= Date.now())).toBe(true);
  });

  it("all accounts throttled → 429 all_accounts_throttled", async () => {
    const script = Array.from({ length: 20 }, () => () => jsonResponse({ e: "rl" }, 429, { "retry-after": "1" }));
    const { pool } = setup(script);
    const { response, accountId } = await pool.execute("messages", (call) => call("/v1/messages", { model: "m" }));
    expect(response.status).toBe(429);
    expect(accountId).toBe("");
    expect((await response.json()).error.type).toBe("all_accounts_throttled");
  });
});
