export type GetHeader = (k: string) => string | null | undefined;

export type Outcome =
  | { kind: "ok"; fallbackTo: string | null }
  | { kind: "model_unavailable"; status: number }
  | { kind: "account_throttled" }
  | { kind: "account_refused"; reason: string; status: number }
  | { kind: "relay_exhausted"; status: number }
  | { kind: "ignored" };

/**
 * The relay's own names for "the budget everyone shares is spent" — a family,
 * not a pair.
 *
 * It was a two-element set of exact strings, taken from the two names the app
 * had been seen to branch on. The app does not compare: 0.0.208 tests the error
 * against this alternation, because the same refusal arrives under several words.
 * An exact set makes the *unenumerated* word the dangerous one — it falls through
 * to a model verdict, which is how a working model gets marked dead pool-wide.
 */
const RELAY_WIDE_ERROR_TYPES = /credit_exhausted|usage_limit|insufficient_quota|quota_exceeded|billing/i;

/**
 * The relay saying "slow down". About the caller, never about the model — and it
 * arrives without `retry-after`, so nothing else here would catch it.
 */
const TRANSIENT_ERROR_TYPES = /rate_?limit|throttl|too_many/i;

/**
 * A refusal that belongs to the account and will not lift on its own.
 *
 * The app looks for this on a 403's *message*, not on a 429's type — an account
 * without the entitlement a route requires is turned away before any quota is
 * touched. Untyped, a 403 lands in `ignored`, which is safe but silent: the
 * account looks like a request that merely failed and nothing ever names why.
 */
const ENTITLEMENT_REFUSAL = /plan|entitle|invite|subscription/i;

/**
 * An account's window counts as spent only at 100%, which is the bar the app
 * uses too. Below it, a shared-budget rejection says nothing about the account.
 */
const SPENT_UTILIZATION = 1;

/**
 * The relay's error object, whatever framing it arrived in.
 *
 * A streaming request that fails answers in its own framing, so the body is
 * `data: {…}` rather than `{…}`, and a proxy failing in front of the relay
 * answers with an HTML page. Reading only the bare shape means every rule that
 * depends on the body stops applying on exactly the requests Claude Code makes —
 * it always streams — and classification falls through to blaming the model.
 *
 * The unwrapping matches the app: an `error` envelope if there is one, otherwise
 * the object itself.
 */
function relayError(text: string): { type?: unknown; message?: unknown } | undefined {
  const t = text.trim();
  // `<` is an HTML error page, and no amount of parsing will find a type in it.
  if (!t || t.startsWith("<")) return undefined;
  const json = t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5).trim();
  if (!json.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(json);
    return parsed?.error ?? parsed;
  } catch {
    return undefined;
  }
}

/** The relay's `error.type`, if the body carries one. */
export function relayErrorType(text: string): string | undefined {
  const t = relayError(text)?.type;
  return typeof t === "string" ? t : undefined;
}

/**
 * The relay's `error.message`.
 *
 * Needed as well as the type because the relay says some things only in prose —
 * the app keeps a table of exact messages (`missing user token`, `device session
 * replay`) precisely because no code accompanies them.
 */
export function relayErrorMessage(text: string): string | undefined {
  const m = relayError(text)?.message;
  return typeof m === "string" ? m : undefined;
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
  opts: { errorType?: string; errorMessage?: string; throttleUtilization?: number } = {},
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
    if (opts.errorType && RELAY_WIDE_ERROR_TYPES.test(opts.errorType) && (util ?? 0) < SPENT_UTILIZATION)
      return { kind: "relay_exhausted", status };
    if (getHeader("retry-after")) return { kind: "account_throttled" };
    if (util != null && util >= throttleUtilization) return { kind: "account_throttled" };
    // Reached only when the headers said nothing: a named throttle still has to
    // beat the fall-through below, which blames the model.
    if (opts.errorType && TRANSIENT_ERROR_TYPES.test(opts.errorType)) return { kind: "account_throttled" };
    return { kind: "model_unavailable", status };
  }
  if (status >= 500) return { kind: "model_unavailable", status };
  if (status === 403 && ENTITLEMENT_REFUSAL.test(`${opts.errorType ?? ""} ${opts.errorMessage ?? ""}`))
    return { kind: "account_refused", reason: "entitlement", status };
  return { kind: "ignored" };
}
