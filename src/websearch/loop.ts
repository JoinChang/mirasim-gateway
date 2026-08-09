import type { Dialect, SearchRow } from "../types/wire.js";

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

export async function runWebSearchLoop(params: {
  adapter: DialectAdapter;
  hop: (body: unknown) => Promise<{ status: number; json: any }>;
  search: (query: string) => Promise<SearchRow[]>;
  maxUses: number;
  maxHops?: number;
}): Promise<{ status: number; json: any }> {
  const { adapter, hop, search } = params;
  const maxHops = params.maxHops ?? 4;
  let searches = 0;
  let last: any = null;
  for (let h = 0; h < maxHops; h++) {
    const r = await hop(adapter.body());
    if (r.status !== 200) return r;
    last = r.json;
    const calls = adapter.parseToolCalls(r.json);
    if (calls.length === 0 || searches >= params.maxUses) return adapter.finalize(r.json);
    adapter.onAssistant(r.json);
    const results: { id: string; query: string; rows: SearchRow[] }[] = [];
    for (const c of calls) {
      searches++;
      results.push({ id: c.id, query: c.query, rows: await search(c.query) });
    }
    adapter.onToolResults(results);
  }
  return adapter.finalize(last);
}
