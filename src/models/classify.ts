export type GetHeader = (k: string) => string | null | undefined;

export type Outcome =
  | { kind: "ok"; fallbackTo: string | null }
  | { kind: "model_unavailable"; status: number }
  | { kind: "account_throttled" }
  | { kind: "ignored" };

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
 */
export function classifyOutcome(status: number, getHeader: GetHeader, throttleUtilization = 0.9): Outcome {
  if (status >= 200 && status < 300) {
    const attempted = Number.parseInt(getHeader("x-litellm-attempted-fallbacks") ?? "0", 10);
    const group = getHeader("x-litellm-model-group") ?? null;
    return { kind: "ok", fallbackTo: attempted > 0 ? group : null };
  }
  if (status === 429) {
    if (getHeader("retry-after")) return { kind: "account_throttled" };
    const util = utilizationFrom(getHeader);
    if (util != null && util >= throttleUtilization) return { kind: "account_throttled" };
    return { kind: "model_unavailable", status };
  }
  if (status >= 500) return { kind: "model_unavailable", status };
  return { kind: "ignored" };
}
