import crypto from "node:crypto";
import type { DeviceIdentity } from "./device.js";

export const SIG_SCHEME = "mrs-sig-v1";

export function canonicalString(p: {
  method: string;
  pathname: string;
  ts: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [SIG_SCHEME, p.method.toUpperCase(), p.pathname, p.ts, p.nonce, p.bodySha256].join("\n");
}

/** mrs-sig-v1 request signature headers (device/ts/nonce/sig + client). */
export function signatureHeaders(
  id: DeviceIdentity,
  req: { method: string; pathname: string; body: Buffer },
  clientVersion: string,
): Record<string, string> {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString("base64url");
  const bodySha256 = crypto
    .createHash("sha256")
    .update(req.body ?? Buffer.alloc(0))
    .digest("hex");
  const sig = id.sign(canonicalString({ method: req.method, pathname: req.pathname, ts, nonce, bodySha256 }));
  return {
    "x-mirasim-device": id.deviceId,
    "x-mirasim-ts": ts,
    "x-mirasim-nonce": nonce,
    "x-mirasim-sig": sig,
    "x-mirasim-client": clientVersion,
  };
}
