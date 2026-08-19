import { describe, expect, it } from "vitest";
import { scrubMessagesBody } from "../../src/upstream/scrub.js";

const ZW = "​";

describe("scrubMessagesBody", () => {
  it("drops the colon the relay's check keys on in the billing line", () => {
    const out = scrubMessagesBody({ system: "x-anthropic-billing-header: cc_version=x" });
    expect(out.system).toBe("x-anthropic-billing-header cc_version=x");
  });

  it("parts the Claude Code identity phrase with a zero-width space", () => {
    const out = scrubMessagesBody({ system: "You are Claude Code, Anthropic's official CLI for Claude." });
    expect(out.system).toBe(`You are Claude Code, ${ZW}Anthropic's official CLI for Claude.`);
    // the model reads the same text once the invisible char is dropped
    expect((out.system as string).replace(ZW, "")).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it("scrubs each text block of an array system, leaving non-text blocks alone", () => {
    const out = scrubMessagesBody({
      system: [
        { type: "text", text: "x-anthropic-billing-header: v" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "You are a helpful agent." },
      ],
    });
    expect(out.system[0].text).toBe("x-anthropic-billing-header v");
    expect(out.system[1].text).toContain(`Claude Code, ${ZW}Anthropic`);
    expect(out.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(out.system[2].text).toBe("You are a helpful agent.");
  });

  it("does not mutate the input", () => {
    const body = { system: "x-anthropic-billing-header:", messages: [] };
    scrubMessagesBody(body);
    expect(body.system).toBe("x-anthropic-billing-header:");
  });

  it("is idempotent — a scrubbed body scrubbed again is unchanged", () => {
    const once = scrubMessagesBody({ system: "You are Claude Code, Anthropic's CLI. x-anthropic-billing-header: v" });
    const twice = scrubMessagesBody(once);
    expect(twice.system).toBe(once.system);
  });

  it("leaves a body with no system untouched", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(scrubMessagesBody(body)).toEqual(body);
  });
});
