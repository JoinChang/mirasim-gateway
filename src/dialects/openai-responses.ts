import { responsesSSE } from "../gateway/sse.js";
import type { GatewayResult } from "../types/wire.js";
import { responsesAnnotations, responsesWebSearchCall, toModelToolResultText } from "../websearch/citations.js";
import { type DialectAdapter, runWebSearchLoop } from "../websearch/loop.js";
import { type DialectDeps, hopJson } from "./deps.js";

const WEB_TOOL = {
  type: "function",
  name: "web_search",
  description: "Search the public web for current information.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const wantsWebSearch = (body: any) =>
  (body.tools ?? []).some((t: any) => t.type === "web_search" || t.type === "web_search_preview");

const normInput = (input: any): any[] =>
  input == null
    ? []
    : typeof input === "string"
      ? [{ role: "user", content: [{ type: "input_text", text: input }] }]
      : Array.isArray(input)
        ? input
        : [input];

function makeAdapter(body: any, cfg: DialectDeps["cfg"]): DialectAdapter {
  const upstreamTools = [
    ...(body.tools ?? []).filter((t: any) => t.type !== "web_search" && t.type !== "web_search_preview"),
    WEB_TOOL,
  ];
  let input: any[] = normInput(body.input);
  const wsItems: any[] = [];
  const cites: any[] = [];
  let searches = 0;
  const base = { ...body, tools: upstreamTools, stream: false };
  delete (base as any).web_search_options;

  return {
    kind: "responses",
    body: () => ({ ...base, input }),
    parseToolCalls: (resp) =>
      (resp?.output ?? [])
        .filter((o: any) => o.type === "function_call" && o.name === "web_search")
        .map((o: any) => {
          let q = "";
          try {
            q = JSON.parse(o.arguments || "{}").query || "";
          } catch {}
          return { id: o.call_id, query: q };
        }),
    onAssistant: (resp) => {
      input = [...input, ...(resp.output ?? [])];
    },
    onToolResults: (results) => {
      for (const r of results) {
        searches++;
        cites.push(...responsesAnnotations(r.rows));
        wsItems.push(responsesWebSearchCall(r.query));
        input = [...input, { type: "function_call_output", call_id: r.id, output: toModelToolResultText(r.rows) }];
      }
    },
    finalize: (resp) => {
      resp.output = [...wsItems, ...(resp.output ?? [])];
      if (cfg.emitCitations && cites.length) {
        const msg = (resp.output ?? []).find((o: any) => o.type === "message");
        if (msg) for (const part of msg.content ?? []) if (part.type === "output_text") part.annotations = cites;
      }
      resp.usage = { ...(resp.usage ?? {}), web_search_requests: searches };
      return { status: 200, json: resp };
    },
  };
}

export async function handleOpenAIResponses(
  deps: DialectDeps,
  body: any,
  stream: boolean,
  betas?: string,
): Promise<GatewayResult> {
  if (!wantsWebSearch(body)) {
    const { response, accountId } = await deps.pool.execute(
      "responses",
      (call) => call("/v1/responses", body),
      body.model,
      { betas },
    );
    if (stream && response.status === 200) return { type: "stream", response, accountId };
    return { type: "json", status: response.status, json: await response.json().catch(() => null), accountId };
  }
  const out = await runWebSearchLoop({
    adapter: makeAdapter(body, deps.cfg),
    hop: (b) => hopJson(deps.pool, "responses", "/v1/responses", b, betas),
    search: deps.search,
    maxUses: 4,
  });
  if (out.status !== 200) return { type: "json", status: out.status, json: out.json };
  return stream
    ? { type: "sse", text: responsesSSE(out.json), json: out.json }
    : { type: "json", status: 200, json: out.json };
}
