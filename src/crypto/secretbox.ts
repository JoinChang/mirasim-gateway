import crypto from "node:crypto";

const PREFIX = "mrs1:";

/** Encrypt a string with AES-256-GCM, wrapped as `mrs1:base64(iv[12]‖tag[16]‖ct)`. */
export function seal(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

/** Decrypt an `mrs1:` value. Non-`mrs1:` values pass through unchanged (plaintext at rest). */
export function open(value: string, key: Buffer | null): string {
  if (!value?.startsWith(PREFIX)) return value;
  if (!key) throw new Error("encrypted value present but no master key configured");
  const b = Buffer.from(value.slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return d.update(b.subarray(28)) + d.final("utf8");
}

export const isSealed = (v: string): boolean => typeof v === "string" && v.startsWith(PREFIX);
