import crypto from "node:crypto";
import type { DeviceIdentity } from "../crypto/device.js";
import { signatureHeaders } from "../crypto/signing.js";
import { filterAnthropicBeta, sanitizeHeader } from "./headers.js";
import { AGENT_FOR_KIND, type Kind, SERVER_SESSION } from "./relay.js";
import { scrubMessagesBody } from "./scrub.js";
import type { Semaphore } from "./sem.js";

/** The stable facts about the relay, fixed once when the transport is built. */
export interface TransportConfig {
  relayBase: string;
  appVersion: string;
  deviceSigning: boolean;
  fetchFn: typeof fetch;
  sem: Semaphore;
}

/** One relay call's per-request facts — everything that varies between calls. */
export interface TransportCall {
  pathname: string;
  kind: Kind;
  body?: unknown;
  /** Defaults to POST. */
  method?: string;
  /** Client's anthropic-beta header; filtered to relay-honoured values here. */
  betas?: string;
  /** The account's access token, and its device ticket when one was issued. */
  token: string;
  ticket: string | null;
  identity: DeviceIdentity | null;
}

/**
 * The one seam between the pool and the wire.
 *
 * Everything about what a Relay request becomes on the wire — the `x-mirasim-*`
 * headers, the collection opt-out, the `anthropic-version` default, the beta
 * filter, the body scrub, the device signature, the concurrency gate — lives
 * behind `send`. The pool hands over the request as data plus the account's
 * credential; it no longer knows the relay's base, the app version, whether
 * signing is on, or which `fetch` to call. A second adapter (a fake in tests)
 * satisfies the same interface, so the pool's own logic is exercised without a
 * real fetch.
 */
export interface RelayTransport {
  send(call: TransportCall): Promise<Response>;
}

export function createRelayTransport(cfg: TransportConfig): RelayTransport {
  return {
    send(call) {
      const method = call.method ?? "POST";
      const hasBody = method !== "GET" && method !== "HEAD" && call.body !== undefined;
      // Only the Anthropic path carries a `system`, and only it hits the content
      // check that parts these two strings; the OpenAI dialects are untouched.
      const outgoing = call.kind === "messages" ? scrubMessagesBody(call.body) : call.body;
      const bodyStr = hasBody ? JSON.stringify(outgoing) : "";
      const cred = call.ticket ?? call.token;
      const headers: Record<string, string> = {
        authorization: `Bearer ${cred}`,
        "x-mirasim-client": cfg.appVersion,
        "x-mirasim-agent": AGENT_FOR_KIND[call.kind],
        "x-mirasim-session": SERVER_SESSION,
        "x-mirasim-call": crypto.randomUUID(),
        // Opt out of collection, always. The prompts flowing through are the
        // downstream caller's and the quota is a pooled account's — neither is
        // ours to volunteer.
        "x-mirasim-collect": "off",
      };
      if (hasBody) headers["content-type"] = "application/json";
      if (call.kind === "messages")
        headers["anthropic-version"] = (call.body as any)?.anthropic_version ?? "2023-06-01";
      // Betas are forwarded as-is bar the one the app itself strips; the relay
      // ignores unknown ones, so a whitelist would only discard what the caller
      // legitimately asked for.
      if (call.betas) {
        const kept = filterAnthropicBeta({ "anthropic-beta": call.betas })["anthropic-beta"];
        if (kept) headers["anthropic-beta"] = kept;
      }
      if (cfg.deviceSigning && call.ticket && call.identity) {
        const sig = signatureHeaders(
          call.identity,
          { method, pathname: call.pathname, body: Buffer.from(bodyStr, "utf8") },
          cfg.appVersion,
        );
        for (const [k, v] of Object.entries(sig)) headers[k] = sanitizeHeader(v);
      }
      return cfg.sem.run(() =>
        cfg.fetchFn(cfg.relayBase + call.pathname, { method, headers, body: hasBody ? bodyStr : undefined }),
      );
    },
  };
}
