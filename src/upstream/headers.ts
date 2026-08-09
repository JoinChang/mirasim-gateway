import { HOP_BY_HOP, KEPT_BETAS } from "./relay.js";

/** Header values must be ASCII; percent-encode anything else (matches desktop). */
export function sanitizeHeader(value: string): string {
  const s = String(value);
  if (!/[^ -~]/.test(s)) return s;
  let out = "";
  for (const ch of s) {
    if (!/[^ -~]/.test(ch) && ch !== "%") {
      out += ch;
      continue;
    }
    for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function stripHopByHop(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

/** Keep only relay-honoured anthropic-beta values; drop the header if none remain. */
export function filterAnthropicBeta(h: Record<string, string>): Record<string, string> {
  const beta = h["anthropic-beta"];
  if (beta === undefined) return h;
  const kept = beta
    .split(",")
    .map((s) => s.trim())
    .filter((s) => KEPT_BETAS.includes(s));
  const out = { ...h };
  if (kept.length) out["anthropic-beta"] = kept.join(",");
  else delete out["anthropic-beta"];
  return out;
}
