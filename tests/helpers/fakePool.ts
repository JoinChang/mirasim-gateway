import type { Pool, RelayRequest } from "../../src/accounts/pool.js";

export const R = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export interface FakePool {
  pool: Pool;
  /** Every request the pool was asked to execute, in order. */
  requests: RelayRequest[];
}

/**
 * One fake for every test that needs a Pool.
 *
 * Since `execute` takes a request object, everything a test used to record by
 * hand — the model, the body, the betas, the pinned account, the call count — is
 * a field of `requests`. That is why four hand-rolled fakes collapsed into this.
 */
export function fakePool(
  opts: {
    /** Responses in order; exhausted entries fall back to `{ok:1}`. */
    script?: Array<() => Response>;
    /** Per-request behaviour, when order alone cannot express it. Wins over `script`. */
    respond?: (req: RelayRequest) => Response;
    /** Fixed account, or derived from the request (e.g. echo `onlyAccount`). */
    accountId?: string | ((req: RelayRequest) => string);
  } = {},
): FakePool {
  const requests: RelayRequest[] = [];
  const script = [...(opts.script ?? [])];
  const pool: Pool = {
    execute: async (req) => {
      requests.push(req);
      const response = opts.respond ? opts.respond(req) : (script.shift() ?? (() => R({ ok: 1 })))();
      const accountId = typeof opts.accountId === "function" ? opts.accountId(req) : (opts.accountId ?? "acct");
      return { response, accountId };
    },
    deviceIdentityFor: () => ({}) as any,
  };
  return { pool, requests };
}
