import crypto from "node:crypto";
import type { SearchRow } from "../types/wire.js";

export const anthropicResultBlocks = (rows: SearchRow[]) =>
  rows.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, page_age: null, encrypted_content: "" }));

export const anthropicCitations = (rows: SearchRow[]) =>
  rows.map((r, i) => ({
    type: "web_search_result_location",
    url: r.url,
    title: r.title,
    cited_text: (r.description || "").slice(0, 300),
    encrypted_index: String(i),
  }));

export const openaiAnnotations = (rows: SearchRow[]) =>
  rows.map((r) => ({ type: "url_citation", url_citation: { url: r.url, title: r.title } }));

export const responsesAnnotations = (rows: SearchRow[]) =>
  rows.map((r) => ({ type: "url_citation", url: r.url, title: r.title }));

export const responsesWebSearchCall = (query: string) => ({
  type: "web_search_call",
  id: `ws_${crypto.randomBytes(8).toString("hex")}`,
  status: "completed",
  action: { type: "search", query },
});

export const toModelToolResultText = (rows: SearchRow[]) =>
  rows.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description}`).join("\n\n") || "No results.";
