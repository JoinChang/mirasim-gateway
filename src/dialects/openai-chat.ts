import type { AppConfig } from "../config/index.js";
import { chatSSE } from "../gateway/sse.js";
import { openaiAnnotations, toModelToolResultText } from "../websearch/citations.js";
import type { DialectAdapter } from "../websearch/loop.js";
import type { DialectSpec } from "./run.js";

const WEB_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the public web for current information.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

const wantsWebSearch = (body: any) =>
  (body.tools ?? []).some((t: any) => t.type === "web_search" || t.type === "web_search_preview") ||
  !!body.web_search_options;

function makeAdapter(body: any, cfg: AppConfig): DialectAdapter {
  const upstreamTools = [
    ...(body.tools ?? []).filter((t: any) => t.type !== "web_search" && t.type !== "web_search_preview"),
    WEB_TOOL,
  ];
  let messages: any[] = [...(body.messages ?? [])];
  const annotations: any[] = [];
  let searches = 0;
  const base = { ...body, tools: upstreamTools, stream: false };
  delete (base as any).web_search_options;

  return {
    kind: "chat",
    body: () => ({ ...base, messages }),
    parseToolCalls: (resp) =>
      (resp?.choices?.[0]?.message?.tool_calls ?? [])
        .filter((c: any) => c.function?.name === "web_search")
        .map((c: any) => {
          let q = "";
          try {
            q = JSON.parse(c.function.arguments || "{}").query || "";
          } catch {}
          return { id: c.id, query: q };
        }),
    onAssistant: (resp) => {
      messages = [...messages, resp.choices[0].message];
    },
    onToolResults: (results) => {
      for (const r of results) {
        searches++;
        annotations.push(...openaiAnnotations(r.rows));
        messages = [...messages, { role: "tool", tool_call_id: r.id, content: toModelToolResultText(r.rows) }];
      }
    },
    finalize: (resp) => {
      if (cfg.emitCitations && annotations.length && resp?.choices?.[0]?.message)
        resp.choices[0].message.annotations = annotations;
      resp.usage = { ...(resp.usage ?? {}), web_search_requests: searches };
      return { status: 200, json: resp };
    },
  };
}

export const chatDialect: DialectSpec = {
  kind: "chat",
  pathname: "/v1/chat/completions",
  wantsWebSearch,
  maxUses: () => 4,
  makeAdapter,
  toSSE: chatSSE,
};
