import type { RelayTransport, TransportCall } from "../../src/upstream/transport.js";

export interface FakeTransport {
  transport: RelayTransport;
  /** Every relay call the pool sent, in order — model, betas, credential, etc. */
  calls: TransportCall[];
}

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

/**
 * A transport at the same seam the real one fills, for testing the pool without
 * a fetch. Responses come either from a `script` (in order; exhausted entries
 * fall back to a bare 200) or from a `respond(n, call)` function where `n` is the
 * 1-based call count — which can also throw to simulate a transport-level error.
 * Every call is recorded for assertions.
 */
export function fakeTransport(
  respond: Array<() => Response> | ((n: number, call: TransportCall) => Response) = [],
): FakeTransport {
  const calls: TransportCall[] = [];
  const script = Array.isArray(respond) ? [...respond] : null;
  const responder = typeof respond === "function" ? respond : null;
  const transport: RelayTransport = {
    async send(call) {
      calls.push(call);
      if (responder) return responder(calls.length, call) ?? ok();
      const next = script?.shift();
      return next ? next() : ok();
    },
  };
  return { transport, calls };
}
