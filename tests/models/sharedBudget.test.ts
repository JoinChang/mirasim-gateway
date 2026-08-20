import { describe, expect, it } from "vitest";
import { createPool } from "../../src/accounts/pool.js";
import { createRefresher } from "../../src/accounts/refresh.js";
import { accountStore } from "../../src/accounts/store.js";
import { createTicketManager } from "../../src/accounts/ticket.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { explainRelayError } from "../../src/gateway/relayErrors.js";
import { classifyOutcome, relayErrorType } from "../../src/models/classify.js";
import { jsonResponse, mkJwt } from "../helpers/fakes.js";
import { fakeTransport } from "../helpers/fakeTransport.js";

const hdrs =
  (h: Record<string, string>) =>
  (k: string): string | null =>
    h[k] ?? null;

/** What the relay actually sends, recorded live on 2026-08-13. */
const EXHAUSTED = {
  type: "error",
  error: {
    type: "credit_exhausted_shared",
    message: "中转的共享额度已用尽,暂时无法为这个账号提供服务。/ The relay's shared quota is used up.",
  },
};

describe("shared-budget 429", () => {
  it("is told apart from an account throttle even though it sends retry-after", () => {
    const h = hdrs({ "retry-after": "3600", "anthropic-ratelimit-unified-7d-utilization": "0.1996" });
    expect(classifyOutcome(429, h, { errorType: "credit_exhausted_shared" })).toEqual({
      kind: "relay_exhausted",
      status: 429,
    });
    // Without the body it is indistinguishable — which is how five healthy
    // accounts came to carry hundreds of consecutive failures.
    expect(classifyOutcome(429, h)).toEqual({ kind: "account_throttled" });
  });

  it("still counts against the account once that account's own window is spent", () => {
    const h = hdrs({ "retry-after": "3600", "anthropic-ratelimit-unified-7d-utilization": "1" });
    expect(classifyOutcome(429, h, { errorType: "credit_exhausted_shared" })).toEqual({ kind: "account_throttled" });
  });

  it("reads the relay's error type out of a body, and shrugs at anything else", () => {
    expect(relayErrorType(JSON.stringify(EXHAUSTED))).toBe("credit_exhausted_shared");
    expect(relayErrorType("<html>502</html>")).toBeUndefined();
    expect(relayErrorType("{}")).toBeUndefined();
  });

  it("explains the 429 to downstream clients, keeping the relay's own wording", () => {
    const out = explainRelayError(429, EXHAUSTED);
    expect(out.error.message).toMatch(/shared budget, not your account/);
    expect(out.error.message).toContain("中转的共享额度已用尽");
    expect(out.error.type).toBe("credit_exhausted_shared");
    expect(explainRelayError(429, { error: { type: "rate_limit_error" } })).toBeNull();
  });

  it("asks every account before giving up — restoration arrives one batch at a time", async () => {
    // The relay restores accounts in batches, so a refusal from the first
    // account says nothing about the fourth. Answering 429 without asking would
    // strand a working account.
    const db = memDb();
    const store = accountStore({ db, masterKey: null });
    for (let i = 0; i < 5; i++) store.add({ id: `a${i}`, refreshToken: `r${i}` });
    const fetchFn = (async () =>
      jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) })) as any;
    // Only the fourth account has been let back in.
    const { transport, calls } = fakeTransport((n) =>
      n === 4
        ? jsonResponse({ ok: true }, 200)
        : jsonResponse(EXHAUSTED, 429, {
            "retry-after": "3600",
            "anthropic-ratelimit-unified-7d-utilization": "0.1996",
          }),
    );
    const config = loadConfig({
      fileJson: { deviceSigning: false, cooldownMs: 40, maxWaitMs: 300, maxAttempts: 8 },
      env: {},
    });
    const pool = createPool({
      store,
      refresher: createRefresher({ store, loginBase: "https://login", fetchFn }),
      ticketManager: createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: config.appVersion }),
      config,
      transport,
    });

    const { response, accountId } = await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "m" },
    });
    expect(response.status).toBe(200);
    expect(accountId).toBeTruthy();
    expect(calls.length).toBe(4);
    // The three that refused are still clean — they were not at fault.
    expect(store.list().every((a) => a.consecutiveFails === 0)).toBe(true);
    expect(store.list().every((a) => a.disabledUntil <= Date.now())).toBe(true);
  });

  it("blames nobody and quotes the relay when every account is refused", async () => {
    const db = memDb();
    const store = accountStore({ db, masterKey: null });
    for (let i = 0; i < 5; i++) store.add({ id: `a${i}`, refreshToken: `r${i}` });
    const fetchFn = (async () =>
      jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) })) as any;
    const { transport, calls } = fakeTransport(() =>
      jsonResponse(EXHAUSTED, 429, {
        "retry-after": "3600",
        "anthropic-ratelimit-unified-7d-utilization": "0.1996",
      }),
    );
    const config = loadConfig({
      fileJson: { deviceSigning: false, cooldownMs: 40, maxWaitMs: 300, maxAttempts: 8 },
      env: {},
    });
    const pool = createPool({
      store,
      refresher: createRefresher({ store, loginBase: "https://login", fetchFn }),
      ticketManager: createTicketManager({ relayBase: "https://relay", fetchFn, appVersion: config.appVersion }),
      config,
      transport,
    });

    const { response, accountId } = await pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model: "m" },
    });

    expect(response.status).toBe(429);
    expect(((await response.json()) as any).error.type).toBe("credit_exhausted_shared");
    expect(accountId).toBeTruthy();
    expect(calls.length).toBe(5); // walked all five rather than stranding a possible survivor
    expect(store.list().every((a) => a.disabledUntil <= Date.now())).toBe(true);
    expect(store.list().every((a) => a.consecutiveFails === 0)).toBe(true);
  });
});
