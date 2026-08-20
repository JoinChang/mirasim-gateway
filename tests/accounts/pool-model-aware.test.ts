import { describe, expect, it } from "vitest";
import { createPool } from "../../src/accounts/pool.js";
import { createRefresher } from "../../src/accounts/refresh.js";
import { accountStore } from "../../src/accounts/store.js";
import { createTicketManager } from "../../src/accounts/ticket.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import type { Outcome } from "../../src/models/classify.js";
import { jsonResponse, mkJwt } from "../helpers/fakes.js";
import { fakeTransport } from "../helpers/fakeTransport.js";

function setup(relayScript: Array<() => Response>) {
  const db = memDb();
  const store = accountStore({ db, masterKey: null });
  for (const id of ["a1", "a2", "a3"]) store.add({ id, refreshToken: `r-${id}` });
  const fetchFn = (async () =>
    jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) })) as any;
  const { transport, calls } = fakeTransport(relayScript);
  const config = loadConfig({
    fileJson: {
      deviceSigning: false,
      cooldownMs: 5_000,
      maxWaitMs: 300,
      maxAttempts: 6,
      retry5xx: 2,
      retry5xxDelayMs: 5,
    },
    env: {},
  });
  const seen: Array<{ model: string; outcome: Outcome }> = [];
  const refresher = createRefresher({ store, loginBase: "https://login", fetchFn });
  const ticketManager = createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: config.appVersion });
  const pool = createPool({
    store,
    refresher,
    ticketManager,
    config,
    transport,
    onOutcome: (model, outcome) => seen.push({ model, outcome }),
  });
  return { pool, store, seen, relayCalls: () => calls.length };
}

const lowUtil429 = () => jsonResponse({ error: "rl" }, 429, { "anthropic-ratelimit-unified-7d-utilization": "0.004" });

describe("pool.execute is model-aware", () => {
  it("a model-level 429 cools no account — the model is dead, the accounts are fine", async () => {
    const { pool, store } = setup([lowUtil429()].map((r) => () => r));
    await pool.execute({
      kind: "responses",
      pathname: "/v1/responses",
      body: { model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
    });
    expect(store.list().every((a) => a.disabledUntil <= Date.now())).toBe(true);
  });

  it("a model-level 429 gives up immediately instead of retrying every account", async () => {
    const script = Array.from({ length: 10 }, () => lowUtil429);
    const { pool, relayCalls } = setup(script);
    const { response } = await pool.execute({
      kind: "responses",
      pathname: "/v1/responses",
      body: { model: "gpt-5.6-sol" },
      model: "gpt-5.6-sol",
    });
    expect(response.status).toBe(429);
    expect(relayCalls()).toBe(1);
  });

  it("an account-level 429 still cools that account and fails over", async () => {
    const { pool, store } = setup([
      () => jsonResponse({ error: "rl" }, 429, { "retry-after": "1" }),
      () => jsonResponse({ ok: 2 }, 200),
    ]);
    const { response } = await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "m" },
      model: "m",
    });
    expect(response.status).toBe(200);
    expect(store.list().filter((a) => a.disabledUntil > Date.now()).length).toBe(1);
  });

  const entitlement403 = () =>
    jsonResponse({ error: { type: "forbidden", message: "your plan does not include this model" } }, 403);

  it("an entitlement 403 is the account's, so it fails over instead of being handed back", async () => {
    const { pool, seen } = setup([entitlement403, () => jsonResponse({ ok: 2 }, 200)]);
    const { response } = await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "m" },
      model: "m",
    });
    expect(response.status).toBe(200);
    expect(seen[0]).toEqual({
      model: "m",
      outcome: { kind: "account_refused", reason: "entitlement", status: 403 },
    });
  });

  it("an entitlement 403 takes that account out of rotation, so the next request does not pay for it again", async () => {
    const { pool, store } = setup([entitlement403, () => jsonResponse({ ok: 2 }, 200)]);
    await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" }, model: "m" });
    expect(store.list().filter((a) => a.disabledUntil > Date.now()).length).toBe(1);
  });

  it("a quota 429 wearing SSE framing is still the relay's budget, not a dead model", async () => {
    const body = 'event: error\ndata: {"error":{"type":"credit_exhausted_shared","message":"spent"}}\n\n';
    const { pool, seen } = setup([
      () =>
        new Response(body, {
          status: 429,
          headers: { "content-type": "text/event-stream", "anthropic-ratelimit-unified-7d-utilization": "0.004" },
        }),
      () => jsonResponse({ ok: 2 }, 200),
    ]);
    await pool.execute({ kind: "messages", pathname: "/v1/messages", body: { model: "m" }, model: "m" });
    expect(seen[0]!.outcome).toEqual({ kind: "relay_exhausted", status: 429 });
  });

  it("reports what it learned about the model", async () => {
    const { pool, seen } = setup([() => jsonResponse({ ok: 1 }, 200)]);
    await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "claude-opus-5" },
      model: "claude-opus-5",
    });
    expect(seen).toEqual([{ model: "claude-opus-5", outcome: { kind: "ok", fallbackTo: null } }]);
  });

  it("pins execution to a named account when asked, ignoring who the pool would prefer", async () => {
    const { pool, store } = setup([]);
    // Make a3 the least attractive pick, so only an explicit pin can select it.
    store.setUtilization("a3", 0.9);
    const { accountId } = await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "m" },
      model: "m",
      onlyAccount: "a3",
    });
    expect(accountId).toBe("a3");
  });

  it("does not quietly fail over to another account when pinned", async () => {
    const { pool, store } = setup([() => jsonResponse({ error: "rl" }, 429, { "retry-after": "1" })]);
    store.setDisabledUntil("a1", Date.now() + 60_000);
    const { accountId, response } = await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "m" },
      model: "m",
      onlyAccount: "a1",
    });
    expect(accountId).not.toBe("a2");
    expect(accountId).not.toBe("a3");
    expect(response.status).toBe(429);
  });

  it("says nothing about the model when the caller did not name one", async () => {
    const { pool, seen } = setup([() => jsonResponse({ ok: 1 }, 200)]);
    await pool.execute({ kind: "chat", pathname: "/v1/models", method: "GET" });
    expect(seen).toEqual([]);
  });
});
