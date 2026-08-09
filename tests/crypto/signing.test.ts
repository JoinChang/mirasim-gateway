import { describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/device.js";
import { canonicalString, SIG_SCHEME, signatureHeaders } from "../../src/crypto/signing.js";

describe("signing", () => {
  it("canonical joins scheme/METHOD/path/ts/nonce/bodySha with newline", () => {
    expect(
      canonicalString({ method: "post", pathname: "/v1/messages", ts: "123", nonce: "n", bodySha256: "abc" }),
    ).toBe(`${SIG_SCHEME}\nPOST\n/v1/messages\n123\nn\nabc`);
  });
  it("headers include device/ts/nonce/sig/client", () => {
    const h = signatureHeaders(
      generateIdentity(),
      { method: "POST", pathname: "/v1/messages", body: Buffer.from("{}") },
      "0.0.148",
    );
    for (const k of ["x-mirasim-device", "x-mirasim-ts", "x-mirasim-nonce", "x-mirasim-sig", "x-mirasim-client"])
      expect(h[k]).toBeTruthy();
    expect(h["x-mirasim-client"]).toBe("0.0.148");
  });
});
