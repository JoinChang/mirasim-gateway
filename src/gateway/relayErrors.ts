/**
 * Rewrite upstream errors that describe themselves badly.
 *
 * The relay reports "shared cloud budget spent" as `403 permission_error:
 * This request was not authorized.` — which every Anthropic client, Claude Code
 * included, renders as an authentication failure. It is not: the same response
 * carries the account's own quota at a fraction of a percent, and every pooled
 * account shares the exhausted budget, so failing over cannot help.
 *
 * The status and error type are left alone — inventing a 429 would be guessing at
 * semantics we cannot verify, and clients switch on both. Only the message is
 * rewritten, since that is the string clients print, and the relay's own wording
 * is kept inside it.
 */
export function explainRelayError(status: number, json: any): any | null {
  if (status !== 403) return null;
  if (!json || typeof json !== "object") return null;
  const err = json.error;
  if (!err || typeof err !== "object" || err.type !== "permission_error") return null;

  const upstream = typeof err.message === "string" ? err.message : "";
  return {
    ...json,
    error: {
      ...err,
      message:
        "relay cloud capacity is exhausted — this is the relay's shared budget, not your account, " +
        "and every pooled account draws on it, so retrying on another will not help. " +
        `Try again in a few minutes. Upstream said: ${upstream}`,
    },
  };
}
