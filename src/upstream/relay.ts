import crypto from "node:crypto";
export type Kind = "messages" | "chat" | "responses";
export const AGENT_FOR_KIND: Record<Kind, string> = { messages: "claude", chat: "codex", responses: "codex" };
export const KEPT_BETAS = ["context-1m-2025-08-07"];
export const HOP_BY_HOP = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
  "keep-alive",
  "upgrade",
]);
export const SERVER_SESSION = crypto.randomUUID();
export const DEVICE_SESSION_PATH = "/v1/device/session";
