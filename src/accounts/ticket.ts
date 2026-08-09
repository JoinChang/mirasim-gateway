import type { DeviceIdentity } from "../crypto/device.js";
import { signatureHeaders } from "../crypto/signing.js";
import { DEVICE_SESSION_PATH } from "../upstream/relay.js";

const RENEW_MARGIN_MS = 120_000;
const RETRY_MS = 30_000;
const UNSUPPORTED_MS = 900_000;
const DEFAULT_TTL_MS = 600_000;

export function createTicketManager(opts: {
  relayBase: string;
  fetchFn: typeof fetch;
  appVersion: string;
  now?: () => number;
}) {
  const now = () => opts.now?.() ?? Date.now();
  const tickets = new Map<string, { ticket: string; expiresAtMs: number }>();
  const nextAttempt = new Map<string, number>();
  const unsupportedUntil = new Map<string, number>();

  async function ensure(accountId: string, issuerToken: string, identity: DeviceIdentity): Promise<string | null> {
    const t = now();
    const cur = tickets.get(accountId);
    if (cur && t < cur.expiresAtMs - RENEW_MARGIN_MS) return cur.ticket;
    if (t < (nextAttempt.get(accountId) ?? 0) || t < (unsupportedUntil.get(accountId) ?? 0))
      return cur && t < cur.expiresAtMs ? cur.ticket : null;
    nextAttempt.set(accountId, t + RETRY_MS);

    const body = JSON.stringify({ publicKey: identity.publicKeyB64, deviceId: identity.deviceId });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${issuerToken}`,
      ...signatureHeaders(
        identity,
        { method: "POST", pathname: DEVICE_SESSION_PATH, body: Buffer.from(body, "utf8") },
        opts.appVersion,
      ),
    };
    try {
      const res = await opts.fetchFn(opts.relayBase + DEVICE_SESSION_PATH, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404 || res.status === 501) {
        unsupportedUntil.set(accountId, t + UNSUPPORTED_MS);
        res.body?.cancel?.().catch(() => {});
        return null;
      }
      if (!res.ok) {
        res.body?.cancel?.().catch(() => {});
        return cur && t < cur.expiresAtMs ? cur.ticket : null;
      }
      const j = (await res.json()) as { ticket?: string; expiresIn?: number; expiresAt?: number };
      if (typeof j.ticket !== "string" || !j.ticket) return null;
      const expiresAtMs =
        typeof j.expiresIn === "number"
          ? t + j.expiresIn * 1000
          : typeof j.expiresAt === "number"
            ? j.expiresAt * 1000
            : t + DEFAULT_TTL_MS;
      tickets.set(accountId, { ticket: j.ticket, expiresAtMs });
      nextAttempt.set(accountId, 0);
      unsupportedUntil.set(accountId, 0);
      return j.ticket;
    } catch {
      return cur && t < cur.expiresAtMs ? cur.ticket : null;
    }
  }

  return { ensure };
}
export type TicketManager = ReturnType<typeof createTicketManager>;
