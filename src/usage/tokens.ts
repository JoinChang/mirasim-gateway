import type { UsageTotals } from "../types/wire.js";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Total input tokens a request actually consumed.
 *
 * The dialects disagree about what "input" means. Anthropic reports
 * `input_tokens` for the uncached part only, with cache creation and cache reads
 * carried in separate fields — measured against this relay, a 4804-token cached
 * system prompt reports `input_tokens: 9`, so billing that figure undercounts by
 * two orders of magnitude. Clients that lean on prompt caching (Claude Code does
 * by default) were effectively exempt from downstream key quotas.
 *
 * OpenAI's `prompt_tokens` already includes cached input, with
 * `prompt_tokens_details.cached_tokens` as a breakdown, so it is taken as-is —
 * adding the cache fields there would double count.
 */
export function totalInputTokens(usage: any): number {
  if (usage == null || typeof usage !== "object") return 0;
  if (typeof usage.prompt_tokens === "number") return num(usage.prompt_tokens);
  if (typeof usage.input_tokens === "number")
    return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
  return num(usage.input_tokens_details?.total);
}

export function totalOutputTokens(usage: any): number {
  if (usage == null || typeof usage !== "object") return 0;
  return num(usage.output_tokens) || num(usage.completion_tokens);
}

/**
 * Totals for a complete response body. The only place a body is read for usage —
 * the streaming path measures as it flows, and the search loop sums its own hops.
 */
export function usageTotalsFrom(json: any): UsageTotals {
  const u = json?.usage;
  const searches = u?.server_tool_use?.web_search_requests ?? u?.web_search_requests ?? 0;
  return {
    inputTokens: totalInputTokens(u),
    outputTokens: totalOutputTokens(u),
    webSearchRequests: Number(searches) || 0,
  };
}
