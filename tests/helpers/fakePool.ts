import type { Pool } from "../../src/accounts/pool.js";
export function fakePool(script: Array<() => Response>): Pool {
  return {
    execute: async (_kind, buildAndCall) => {
      const call = async () => {
        const next = script.shift();
        return next ? next() : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      };
      const response = await buildAndCall(call);
      return { response, accountId: "acct" };
    },
    deviceIdentityFor: () => ({}) as any,
  };
}
export const R = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
