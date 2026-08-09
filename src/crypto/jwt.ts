/** Decode (not verify) a JWT payload. Returns null if unparseable. */
export function decodeJwt(token: string): Record<string, any> | null {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
