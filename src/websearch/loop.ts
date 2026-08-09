import type { Dialect, SearchRow, UsageTotals } from "../types/wire.js";
import { totalInputTokens, totalOutputTokens } from "../usage/tokens.js";

export interface DialectAdapter {
  kind: Dialect;
  /** Body to send for the next hop (with server web_search stripped + custom tool injected). */
  body(): unknown;
  /** Extract web_search tool calls from a 200 response. */
  parseToolCalls(resp: any): { id: string; query: string }[];
  /** Append the assistant turn (that requested the tool) to the running conversation. */
  onAssistant(resp: any): void;
  /** Append tool results to the conversation + accumulate citations/blocks internally. */
  onToolResults(results: { id: string; query: string; rows: SearchRow[] }[]): void;
  /** Reconstruct native blocks + attach citations on the final response. */
  finalize(lastResp: any): { status: number; json: any };
}

export interface LoopResult {
  status: number;
  json: any;
  /**
   * The account that served the final hop. A loop can span several accounts, and
   * one usage row can only name one; the last is the one that produced the answer
   * the caller receives. Per-account *quota* does not depend on this — the pool
   * records each account's utilisation from the relay headers on every hop.
   */
  accountId?: string;
  /** Tokens across every hop, plus the searches run. Reporting only the final hop hid the rest. */
  usage: UsageTotals;
}

export async function runWebSearchLoop(params: {
  adapter: DialectAdapter;
  hop: (body: unknown) => Promise<{ status: number; json: any; accountId?: string }>;
  search: (query: string) => Promise<SearchRow[]>;
  maxUses: number;
  maxHops?: number;
}): Promise<LoopResult> {
  const { adapter, hop, search } = params;
  const maxHops = params.maxHops ?? 4;
  let searches = 0;
  let last: any = null;
  let accountId: string | undefined;
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 };
  for (let h = 0; h < maxHops; h++) {
    const r = await hop(adapter.body());
    accountId = r.accountId ?? accountId;
    usage.inputTokens += totalInputTokens(r.json?.usage);
    usage.outputTokens += totalOutputTokens(r.json?.usage);
    if (r.status !== 200) return { ...r, accountId, usage };
    last = r.json;
    const calls = adapter.parseToolCalls(r.json);
    if (calls.length === 0 || searches >= params.maxUses) return { ...adapter.finalize(r.json), accountId, usage };
    adapter.onAssistant(r.json);
    const results: { id: string; query: string; rows: SearchRow[] }[] = [];
    for (const c of calls) {
      searches++;
      usage.webSearchRequests++;
      results.push({ id: c.id, query: c.query, rows: await search(c.query) });
    }
    adapter.onToolResults(results);
  }
  return { ...adapter.finalize(last), accountId, usage };
}
