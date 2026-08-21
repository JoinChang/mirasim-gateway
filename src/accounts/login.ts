/**
 * The email-code login the desktop client uses, as two steps.
 *
 * Accounts reach the pool as refresh tokens (`accounts add`/`import`), but the
 * first token has to come from somewhere: the app signs in with an emailed
 * one-time code. These two calls mirror the app's own `/auth/code` and
 * `/auth/verify` exactly (POST JSON, the field names it sends), so the gateway
 * can mint that first token itself rather than depending on a working install.
 *
 * `fetchFn` is injected the way `refresh.ts` injects it, so the flow is testable
 * without touching the network.
 */

/** Ask the login host to email a one-time code. `devCode` is only ever set on a
 *  dev backend that returns the code inline; production emails it and returns none. */
export async function requestCode(
  loginBase: string,
  email: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ devCode?: string }> {
  const res = await fetchFn(`${loginBase}/auth/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    res.body?.cancel?.().catch(() => {});
    throw new Error(`send code failed HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { dev_code?: string };
  return typeof body.dev_code === "string" && body.dev_code ? { devCode: body.dev_code } : {};
}

export interface LoginTokens {
  accessToken: string;
  refreshToken: string;
}

/** Exchange an emailed code for the account's tokens. The access token carries
 *  the claims (`sub`/`email`/`plan`); the refresh token is what the pool stores. */
export async function verifyCode(
  loginBase: string,
  email: string,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoginTokens> {
  const res = await fetchFn(`${loginBase}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    res.body?.cancel?.().catch(() => {});
    throw new Error(`verify failed HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
  if (typeof body.access_token !== "string" || !body.access_token) throw new Error("verify returned no access_token");
  if (typeof body.refresh_token !== "string" || !body.refresh_token)
    throw new Error("verify returned no refresh_token");
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}
