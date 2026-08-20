import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

describe("config", () => {
  it("applies defaults with empty file/env", () => {
    const c0 = loadConfig({ fileJson: {}, env: {} });
    expect(c0.usageTzOffsetHours).toBe(8);
    expect(loadConfig({ fileJson: {}, env: { USAGE_TZ_OFFSET_HOURS: "-5" } }).usageTzOffsetHours).toBe(-5);

    const c = loadConfig({ fileJson: {}, env: {} });
    expect(c.searchProvider).toBe("firecrawl");
    expect(c.deviceSigning).toBe(false);
    expect(c.maxConcurrency).toBe(4);
    expect(c.appVersion).toBe("0.0.208");
    expect(c.loginBase).toBe("https://auth.mirasim.ai");
  });
  it("env overrides file", () => {
    const c = loadConfig({ fileJson: { searchProvider: "serper" }, env: { SEARCH_PROVIDER: "searxng" } });
    expect(c.searchProvider).toBe("searxng");
  });
  it("parses 64-hex master key to 32-byte buffer, else null", () => {
    expect(loadConfig({ fileJson: {}, env: { MIRASIM_MASTER_KEY: "aa".repeat(32) } }).masterKey?.length).toBe(32);
    expect(loadConfig({ fileJson: {}, env: {} }).masterKey).toBeNull();
  });
  it("splits list envs and coerces DEVICE_SIGNING", () => {
    const c = loadConfig({ fileJson: {}, env: { ALLOW_DOMAINS: "a.com, b.com", DEVICE_SIGNING: "0" } });
    expect(c.allowDomains).toEqual(["a.com", "b.com"]);
    expect(c.deviceSigning).toBe(false);
  });
  it("can be switched back on, from env or from the config file", () => {
    // The default is off, but signing is one relay policy change away from being
    // required again — so the switch has to still turn it on both ways.
    expect(loadConfig({ fileJson: {}, env: { DEVICE_SIGNING: "1" } }).deviceSigning).toBe(true);
    expect(loadConfig({ fileJson: { deviceSigning: true }, env: {} }).deviceSigning).toBe(true);
  });
});
