import { describe, expect, it } from "vitest";
import { decodeJwt } from "../../src/crypto/jwt.js";

function mkJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}
describe("jwt", () => {
  it("decodes claims", () => {
    const t = mkJwt({ sub: "usr_1", email: "a@b.c", plan: "max", exp: 123 });
    expect(decodeJwt(t)).toMatchObject({ sub: "usr_1", email: "a@b.c", plan: "max", exp: 123 });
  });
  it("returns null on garbage", () => {
    expect(decodeJwt("nope")).toBeNull();
  });
});
