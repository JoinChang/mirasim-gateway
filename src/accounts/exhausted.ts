/**
 * Why `pool.execute` ran out of accounts to try.
 *
 * Five unrelated failures used to reach the caller as one `all_accounts_throttled`:
 * a refresh that threw, a relay hop that never connected, a genuine 429, a
 * deadline, and having no accounts at all. During an outage that single message
 * is worth nothing — each one needs a different fix, and telling them apart cost
 * hours of guessing. The pool knows which happened; this is it saying so.
 */
export interface AttemptFailure {
  accountId: string;
  stage: "refresh" | "call" | "throttled" | "server_error";
  /** Transport stages: the thrown error, as text. */
  error?: string;
  /** HTTP stages: the status the relay gave. */
  status?: number;
  /** HTTP stages: what the relay's error body said, truncated. */
  body?: string;
  /** HTTP stages: the header that makes a 429 a throttle rather than a refusal. */
  retryAfter?: string;
  /**
   * Device signing was on, but the relay issued no ticket for this attempt, so
   * it went out unticketed. `ticket.ensure` degrades silently by design; when
   * the attempt then fails, this is usually the reason.
   */
  ticketMissing?: boolean;
}

/** Why the attempt loop stopped, which is not the same as why attempts failed. */
export type Stop = "no_accounts" | "deadline" | "max_attempts";

const shortId = (id: string) => id.slice(0, 16);

function describe(f: AttemptFailure): string {
  if (f.stage === "refresh" || f.stage === "call") return f.error ?? f.stage;
  const extra = [f.retryAfter ? `retry-after ${f.retryAfter}` : null, f.body].filter(Boolean).join(" — ");
  return extra ? `HTTP ${f.status} — ${extra}` : `HTTP ${f.status}`;
}

/**
 * The response every caller sees when no account could serve the request. The
 * `type` still reads `all_accounts_throttled` when throttling is genuinely all
 * that happened, so clients keying on it keep working.
 */
export function exhaustedResponse(failures: AttemptFailure[], stop: Stop): Response {
  const type =
    stop === "no_accounts" && failures.length === 0
      ? "no_accounts"
      : failures.length > 0 && failures.every((f) => f.stage === "throttled")
        ? "all_accounts_throttled"
        : "pool_exhausted";

  const message = (() => {
    if (type === "no_accounts") return "no accounts are configured, so nothing could serve this request";
    const counts = new Map<string, number>();
    for (const f of failures) counts.set(f.stage, (counts.get(f.stage) ?? 0) + 1);
    const breakdown = [...counts].map(([s, n]) => `${s}×${n}`).join(", ");
    const last = failures[failures.length - 1];
    const parts = [
      `no account could serve this request — ${failures.length} attempt(s): ${breakdown}`,
      last ? `last was ${last.stage} on ${shortId(last.accountId)}: ${describe(last)}` : null,
      failures.some((f) => f.ticketMissing)
        ? `${failures.filter((f) => f.ticketMissing).length} attempt(s) went out without a device ticket`
        : null,
      `stopped on ${stop}`,
    ].filter(Boolean);
    return parts.join("; ");
  })();

  return new Response(
    JSON.stringify({
      error: {
        type,
        message,
        attempts: failures.map((f) => ({ ...f, accountId: shortId(f.accountId) })),
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}
