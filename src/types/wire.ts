export interface SearchRow {
  url: string;
  title: string;
  description: string;
}
export type Dialect = "messages" | "chat" | "responses";

/**
 * What a request actually consumed, measured by whoever ran it.
 *
 * Required on results that carry a complete body, so nothing downstream has to
 * re-read one and no second source can disagree. Absent on `stream`, whose totals
 * are only known once the body has finished flowing past.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  webSearchRequests: number;
}

export type GatewayResult =
  | { type: "json"; status: number; json: any; accountId?: string; usage: UsageTotals }
  | { type: "stream"; response: Response; accountId?: string }
  | { type: "sse"; text: string; json?: any; status?: number; accountId?: string; usage: UsageTotals };
