import { describe, expect, it } from "vitest";
import { isSealed, open, seal } from "../../src/crypto/secretbox.js";

const KEY = Buffer.alloc(32, 7);
describe("secretbox", () => {
  it("round-trips", () => {
    const c = seal("hello", KEY);
    expect(isSealed(c)).toBe(true);
    expect(open(c, KEY)).toBe("hello");
  });
  it("passes through non-mrs1 values", () => {
    expect(open("plain", KEY)).toBe("plain");
  });
  it("throws on wrong key", () => {
    const c = seal("x", KEY);
    expect(() => open(c, Buffer.alloc(32, 9))).toThrow();
  });
  it("open without key on mrs1 throws", () => {
    const c = seal("x", KEY);
    expect(() => open(c, null)).toThrow(/master key/i);
  });
  it("uses a random iv (distinct ciphertexts)", () => {
    expect(seal("x", KEY)).not.toBe(seal("x", KEY));
  });
});
