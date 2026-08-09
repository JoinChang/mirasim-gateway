export interface SearchRow {
  url: string;
  title: string;
  description: string;
}
export type Dialect = "messages" | "chat" | "responses";

/** Totals the caller measured itself, preferred over re-reading one response body. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export type GatewayResult =
  | { type: "json"; status: number; json: any; accountId?: string; usage?: UsageTotals }
  | { type: "stream"; response: Response; accountId?: string }
  | { type: "sse"; text: string; json?: any; status?: number; accountId?: string; usage?: UsageTotals };
