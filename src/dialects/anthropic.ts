import { anthropicSSE } from "../gateway/sse.js";
import type { GatewayResult } from "../types/wire.js";
import { anthropicCitations, anthropicResultBlocks, toModelToolResultText } from "../websearch/citations.js";
import { type DialectAdapter, runWebSearchLoop } from "../websearch/loop.js";
import { type DialectDeps, hopJson } from "./deps.js";

const SERVER_WS = "web_search_20250305";
const WEB_TOOL = {
  name: "web_search",
  description: "Search the public web for current information. Returns titles, URLs and snippets.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

function makeAdapter(
  body: any,
  cfg: DialectDeps["cfg"],
): { adapter: DialectAdapter; result: () => { status: number; json: any } } {
  const upstreamTools = [...(body.tools ?? []).filter((t: any) => t.type !== SERVER_WS), WEB_TOOL];
  let messages: any[] = [...(body.messages ?? [])];
  const toolResults: any[] = [];
  const emitted: any[] = [];
  const allRows: any[] = [];
  let searches = 0;
  let finalJson: any = null;

  const collectNonWs = (resp: any) => {
    for (const c of resp?.content ?? []) if (!(c.type === "tool_use" && c.name === "web_search")) emitted.push(c);
  };

  const adapter: DialectAdapter = {
    kind: "messages",
    body: () => ({
      model: body.model,
      max_tokens: body.max_tokens ?? 1024,
      ...(body.system ? { system: body.system } : {}),
      messages,
      tools: upstreamTools,
      stream: false,
    }),
    parseToolCalls: (resp) =>
      (resp?.content ?? [])
        .filter((c: any) => c.type === "tool_use" && c.name === "web_search")
        .map((c: any) => ({ id: c.id, query: c.input?.query ?? "" })),
    onAssistant: (resp) => {
      collectNonWs(resp);
      messages = [...messages, { role: "assistant", content: resp.content }];
    },
    onToolResults: (results) => {
      const trs: any[] = [];
      for (const r of results) {
        searches++;
        emitted.push({ type: "server_tool_use", id: r.id, name: "web_search", input: { query: r.query } });
        emitted.push({ type: "web_search_tool_result", tool_use_id: r.id, content: anthropicResultBlocks(r.rows) });
        trs.push({ type: "tool_result", tool_use_id: r.id, content: toModelToolResultText(r.rows) });
        allRows.push(...r.rows);
      }
      messages = [...messages, { role: "user", content: trs }];
    },
    finalize: (resp) => {
      collectNonWs(resp);
      if (cfg.emitCitations && allRows.length) {
        for (let i = emitted.length - 1; i >= 0; i--)
          if (emitted[i].type === "text") {
            emitted[i] = { ...emitted[i], citations: anthropicCitations(allRows.slice(0, cfg.searchLimit)) };
            break;
          }
      }
      finalJson = {
        id: resp.id,
        type: "message",
        role: "assistant",
        model: resp.model ?? body.model,
        content: emitted,
        stop_reason: resp.stop_reason ?? "end_turn",
        stop_sequence: null,
        usage: { ...(resp.usage ?? {}), server_tool_use: { web_search_requests: searches } },
      };
      return { status: 200, json: finalJson };
    },
  };
  void toolResults;
  return { adapter, result: () => ({ status: 200, json: finalJson }) };
}

export async function handleMessages(deps: DialectDeps, body: any, stream: boolean): Promise<GatewayResult> {
  const wantsWs = (body.tools ?? []).some((t: any) => t.type === SERVER_WS);
  if (!wantsWs) {
    const { response, accountId } = await deps.pool.execute(
      "messages",
      (call) => call("/v1/messages", body),
      body.model,
    );
    if (stream && response.status === 200) return { type: "stream", response, accountId };
    return { type: "json", status: response.status, json: await response.json().catch(() => null), accountId };
  }
  const maxUses = (body.tools ?? []).find((t: any) => t.type === SERVER_WS)?.max_uses ?? 4;
  const { adapter } = makeAdapter(body, deps.cfg);
  const out = await runWebSearchLoop({
    adapter,
    hop: (b) => hopJson(deps.pool, "messages", "/v1/messages", b),
    search: deps.search,
    maxUses,
  });
  if (out.status !== 200) return { type: "json", status: out.status, json: out.json };
  return stream
    ? { type: "sse", text: anthropicSSE(out.json), json: out.json }
    : { type: "json", status: 200, json: out.json };
}
