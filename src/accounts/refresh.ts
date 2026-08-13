import { decodeJwt } from "../crypto/jwt.js";
import type { AccountStore, DecryptedAccount } from "./store.js";

const REFRESH_MARGIN_SEC = 900;

export function createRefresher(opts: {
  store: AccountStore;
  loginBase: string;
  fetchFn: typeof fetch;
  now?: () => number;
}) {
  const cache = new Map<string, { token: string; exp: number }>();
  const nowSec = () => Math.floor((opts.now?.() ?? Date.now()) / 1000);

  async function ensureAccessToken(account: DecryptedAccount): Promise<string> {
    const cached = cache.get(account.id);
    if (cached && cached.exp - REFRESH_MARGIN_SEC > nowSec()) return cached.token;

    const res = await opts.fetchFn(`${opts.loginBase}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: account.refreshToken }),
    });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      if (cached) return cached.token;
      throw Object.assign(new Error(`refresh failed HTTP ${res.status}`), { status: res.status });
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
    if (typeof body.access_token !== "string" || !body.access_token) {
      if (cached) return cached.token;
      throw new Error("refresh returned no access_token");
    }
    if (body.refresh_token) opts.store.setRefreshToken(account.id, body.refresh_token);
    const claims = decodeJwt(body.access_token);
    // The token that proves the account also describes it. Recording that here
    // is the difference between a live field and a snapshot: `plan` and `email`
    // used to be written once at `accounts add` and never again — and
    // `accounts import` wrote neither, which is why four accounts read as
    // planless for months while nothing was actually wrong with them.
    opts.store.setProfile(account.id, { email: claims?.email, plan: claims?.plan });
    const exp = Number(claims?.exp ?? nowSec() + 3600);
    cache.set(account.id, { token: body.access_token, exp });
    return body.access_token;
  }

  return { ensureAccessToken, _cache: cache };
}
export type Refresher = ReturnType<typeof createRefresher>;
