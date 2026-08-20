import type { Outcome } from "../models/classify.js";

/**
 * What the pool does to an account after one attempt, as data.
 *
 * `classifyOutcome` decides what a response *means* (the Model verdict). This
 * decides what the pool does about it: hand the response back to the caller, or
 * walk on to the next account — and if walking on, whether to cool the account,
 * whether to count the failure against it, and whether to drop it from this
 * call's rotation. Kept separate from applying those effects so the rules are a
 * pure function of the verdict, testable without a pool or a store.
 *
 * `cool` is a yes/no; the actual cooldown is `cooldownMsFrom`, which reads the
 * relay's headers and the account's fail count and is deep enough already.
 */
export type Reaction =
  | { flow: "return"; fails: "clear" }
  | {
      flow: "continue";
      fails: "clear" | "increment";
      cool: boolean;
      refused: boolean;
      /** How the attempt is recorded in the exhausted-pool breakdown. */
      stage: "throttled" | "refused";
    };

export function reactTo(outcome: Outcome): Reaction {
  switch (outcome.kind) {
    // The relay's shared budget, not this account's window: never cool it, never
    // blame it, but take it out of this call's rotation and keep its words in
    // case every account is refused the same way.
    case "relay_exhausted":
      return { flow: "continue", fails: "clear", cool: false, refused: true, stage: "throttled" };

    // The relay throttled this account: cool it with backoff and count the fail.
    case "account_throttled":
      return { flow: "continue", fails: "increment", cool: true, refused: false, stage: "throttled" };

    // Entitlement refusal — the account's own and permanent, but a mixed-plan
    // pool may hold one that is entitled, so drop this one and walk on.
    case "account_refused":
      return { flow: "continue", fails: "increment", cool: true, refused: true, stage: "refused" };

    // ok, ignored, and model_unavailable all hand the response back to the caller
    // with the account left clean. A retryable 5xx never reaches here — the pool
    // exhausts its retry budget first — so model_unavailable arrives only when
    // there is nothing left to do but return the relay's answer.
    default:
      return { flow: "return", fails: "clear" };
  }
}
