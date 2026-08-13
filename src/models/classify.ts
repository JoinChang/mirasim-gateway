export type GetHeader = (k: string) => string | null | undefined;

export type Outcome =
  | { kind: "ok"; fallbackTo: string | null }
  | { kind: "model_unavailable"; status: number }
  | { kind: "account_throttled" }
  | { kind: "relay_exhausted"; status: number }
  | { kind: "ignored" };

/**
 * The relay's own names for "the budget everyone shares is spent" — as opposed
 * to this account's own window. Taken from the app, which branches on exactly
 * these two before it will blame an account.
 */
const RELAY_WIDE_ERROR_TYPES = new Set(["credit_exhausted_shared", "shared_quota_unavailable"]);

/**
 * An account's window counts as spent only at 100%, which is the bar the app
 * uses too. Below it, a shared-budget rejection says nothing about the account.
 */
const SPENT_UTILIZATION = 1;

/** The relay's `error.type`, if the body is JSON shaped like one. */
export function relayErrorType(text: string): string | undefined {
  try {
    const t = JSON.parse(text)?.error?.type;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Highest reported unified-window utilization, or null when the relay sent none. */
export function utilizationFrom(getHeader: GetHeader): number | null {
  let u: number | null = null;
  for (const h of ["anthropic-ratelimit-unified-5h-utilization", "anthropic-ratelimit-unified-7d-utilization"]) {
    const v = getHeader(h);
    if (v != null) {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) u = Math.max(u ?? 0, n);
    }
  }
  return u;
}

/**
 * Decide what a relay response says about the *model* versus the *account*.
 *
 * The relay is LiteLLM: it answers "no deployment for this model group" with a
 * 429 that looks exactly like a quota 429. The two are told apart by the quota
 * headers — a real account throttle reports near-exhausted utilization or sends
 * retry-after, while a model-level rejection arrives with the quota untouched.
 * Getting this wrong is expensive: treating a model rejection as a throttle
 * cools every account in the pool for a model that will never work.
 *
 * A third meaning shares the same status and is invisible in the headers: the
 * relay's own shared budget running out. It sends `retry-after`, so it read as
 * an account throttle, and the pool dutifully cooled all five accounts, over and
 * over, for four days — while every account sat at a fifth of its own quota.
 * Only `errorType`, which lives in the body, separates it.
 */
export function classifyOutcome(
  status: number,
  getHeader: GetHeader,
  opts: { errorType?: string; throttleUtilization?: number } = {},
): Outcome {
  const throttleUtilization = opts.throttleUtilization ?? 0.9;
  if (status >= 200 && status < 300) {
    const attempted = Number.parseInt(getHeader("x-litellm-attempted-fallbacks") ?? "0", 10);
    const group = getHeader("x-litellm-model-group") ?? null;
    return { kind: "ok", fallbackTo: attempted > 0 ? group : null };
  }
  if (status === 429) {
    const util = utilizationFrom(getHeader);
    // The account's own window has to be genuinely spent before a shared-budget
    // rejection is allowed to count against it.
    if (opts.errorType && RELAY_WIDE_ERROR_TYPES.has(opts.errorType) && (util ?? 0) < SPENT_UTILIZATION)
      return { kind: "relay_exhausted", status };
    if (getHeader("retry-after")) return { kind: "account_throttled" };
    if (util != null && util >= throttleUtilization) return { kind: "account_throttled" };
    return { kind: "model_unavailable", status };
  }
  if (status >= 500) return { kind: "model_unavailable", status };
  return { kind: "ignored" };
}
