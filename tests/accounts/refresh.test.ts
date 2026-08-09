import { describe, expect, it } from "vitest";
import { createRefresher } from "../../src/accounts/refresh.js";
import { accountStore } from "../../src/accounts/store.js";
import { memDb } from "../../src/db/client.js";
import { jsonResponse, mkJwt } from "../helpers/fakes.js";

describe("refresh", () => {
  it("refreshes an expired token, persists rotated refresh token, caches", async () => {
    const db = memDb();
    const store = accountStore({ db, masterKey: null });
    store.add({ id: "u", refreshToken: "RT0" });
    let calls = 0;
    const fetchFn = (async (url: string, init: any) => {
      calls++;
      expect(url).toContain("/auth/refresh");
      expect(JSON.parse(init.body).refresh_token).toBe("RT0");
      return jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "RT1" });
    }) as any;
    const r = createRefresher({ store, loginBase: "https://login", fetchFn });
    const acct = store.get("u")!;
    const tok = await r.ensureAccessToken(acct);
    expect(tok).toMatch(/^eyJ/);
    expect(store.get("u")!.refreshToken).toBe("RT1"); // rotated + persisted
    // second call uses cache (no fetch)
    await r.ensureAccessToken(store.get("u")!);
    expect(calls).toBe(1);
  });
  it("falls back to current token on refresh failure when cached", async () => {
    const db = memDb();
    const store = accountStore({ db, masterKey: null });
    store.add({ id: "u", refreshToken: "RT" });
    // seed cache via a first success
    let ok = true;
    const fetchFn = (async () =>
      ok
        ? jsonResponse({ access_token: mkJwt({ exp: Math.floor(Date.now() / 1000) - 10 }), refresh_token: "RT" }) // already expired → will refetch next time
        : new Response("nope", { status: 500 })) as any;
    const r = createRefresher({ store, loginBase: "x", fetchFn });
    await r.ensureAccessToken(store.get("u")!);
    ok = false;
    const tok = await r.ensureAccessToken(store.get("u")!);
    expect(tok).toMatch(/^eyJ/); // returned cached despite 500
  });
});
