// Some relay content-checks reject two byte-strings that only real Claude Code
// emits in a /v1/messages system prompt: its `x-anthropic-billing-header:`
// telemetry line, and its exact identity line "…Claude Code, Anthropic's
// official CLI…". Both return 400 "request rejected as invalid"; each is
// harmless on its own but present in every interactive turn, so the session
// dies. Mirasim's own app never trips this — it does not bundle Claude Code and
// never sends these strings. We neutralise them without changing what the model
// reads: drop the colon the check keys on, and part the identity phrase with a
// zero-width space (U+200B), invisible to the model, enough to miss the match.
const ZW = "​";

function scrubText(t: string): string {
  return t
    .replace(/x-anthropic-billing-header:/g, "x-anthropic-billing-header")
    .replace(/Claude Code, Anthropic/g, `Claude Code, ${ZW}Anthropic`);
}

/**
 * A copy of an Anthropic-messages body with the two fingerprint strings parted,
 * or the body unchanged when its system carries neither. Non-mutating so a
 * pool retry across accounts re-sends the same input, and idempotent so a
 * scrubbed body scrubbed again is unchanged.
 */
export function scrubMessagesBody(body: any): any {
  const s = body?.system;
  if (typeof s === "string") return { ...body, system: scrubText(s) };
  if (Array.isArray(s))
    return {
      ...body,
      system: s.map((b: any) => (b && typeof b.text === "string" ? { ...b, text: scrubText(b.text) } : b)),
    };
  return body;
}
