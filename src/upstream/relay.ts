import crypto from "node:crypto";
export type Kind = "messages" | "chat" | "responses";
export const AGENT_FOR_KIND: Record<Kind, string> = { messages: "claude", chat: "codex", responses: "codex" };
// The relay ignores anthropic-beta entirely — measured 2026-08-19, a bogus value
// still returns 200 and is never echoed — so forwarding the caller's betas is
// harmless, and will start mattering for free if the relay ever honours them. A
// whitelist did the opposite: it discarded betas the caller legitimately asked
// for. Only `oauth-2025-04-20` is dropped, matching the one value the desktop
// client strips before it forwards.
export const DROPPED_BETAS = ["oauth-2025-04-20"];
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
