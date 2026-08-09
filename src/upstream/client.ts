import crypto from "node:crypto";
import type { DeviceIdentity } from "../crypto/device.js";
import { signatureHeaders } from "../crypto/signing.js";
import { sanitizeHeader } from "./headers.js";
import { AGENT_FOR_KIND, type Kind, SERVER_SESSION } from "./relay.js";
import type { Semaphore } from "./sem.js";

export interface CallCtx {
  token: string;
  ticket: string | null;
  identity: DeviceIdentity | null;
  sem: Semaphore;
}
export interface CallOpts {
  deviceSigning: boolean;
  appVersion: string;
  relayBase: string;
  fetchFn: typeof fetch;
  method?: string;
}

/** One signed relay request. Returns the raw Response (caller reads/streams). */
export function callUpstream(
  ctx: CallCtx,
  pathname: string,
  bodyObj: unknown,
  kind: Kind,
  opts: CallOpts,
): Promise<Response> {
  const method = opts.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD" && bodyObj !== undefined;
  const bodyStr = hasBody ? JSON.stringify(bodyObj) : "";
  const cred = ctx.ticket ?? ctx.token;
  const headers: Record<string, string> = {
    authorization: `Bearer ${cred}`,
    "x-mirasim-client": opts.appVersion,
    "x-mirasim-agent": AGENT_FOR_KIND[kind],
    "x-mirasim-session": SERVER_SESSION,
    "x-mirasim-call": crypto.randomUUID(),
  };
  if (hasBody) headers["content-type"] = "application/json";
  if (kind === "messages") headers["anthropic-version"] = (bodyObj as any)?.anthropic_version ?? "2023-06-01";
  if (opts.deviceSigning && ctx.ticket && ctx.identity) {
    const sig = signatureHeaders(
      ctx.identity,
      { method, pathname, body: Buffer.from(bodyStr, "utf8") },
      opts.appVersion,
    );
    for (const [k, v] of Object.entries(sig)) headers[k] = sanitizeHeader(v);
  }
  return ctx.sem.run(() =>
    opts.fetchFn(opts.relayBase + pathname, { method, headers, body: hasBody ? bodyStr : undefined }),
  );
}
