import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateIdentity, identityFromPem } from "../../src/crypto/device.js";

describe("device", () => {
  it("derives deviceId = sha256(pubB64).base64url[:22]", () => {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const id = identityFromPem(pem);
    const pub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
    const expected = crypto.createHash("sha256").update(pub).digest("base64url").slice(0, 22);
    expect(id.deviceId).toBe(expected);
    expect(id.deviceId).toHaveLength(22);
  });
  it("is stable for the same key and verifiable", () => {
    const a = generateIdentity();
    const b = identityFromPem(a.pem);
    expect(b.deviceId).toBe(a.deviceId);
    const sig = a.sign("msg");
    const ok = crypto.verify(null, Buffer.from("msg"), crypto.createPublicKey(a.pem), Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});
