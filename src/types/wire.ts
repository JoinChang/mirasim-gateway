export interface SearchRow {
  url: string;
  title: string;
  description: string;
}
export type Dialect = "messages" | "chat" | "responses";

export type GatewayResult =
  | { type: "json"; status: number; json: any; accountId?: string }
  | { type: "stream"; response: Response; accountId?: string }
  | { type: "sse"; text: string; json?: any; status?: number; accountId?: string };
