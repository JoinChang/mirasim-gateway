import { describe, expect, it } from "vitest";
import { requestCode, verifyCode } from "../../src/accounts/login.js";
import { jsonResponse, mkJwt } from "../helpers/fakes.js";

describe("requestCode", () => {
  it("POSTs the email to /auth/code and reports nothing to echo when no dev_code", async () => {
    let seen: { url: string; body: any } | null = null;
    const fetchFn = (async (url: string, init: any) => {
      seen = { url, body: JSON.parse(init.body) };
      expect(init.method).toBe("POST");
      return jsonResponse({ sent: true, dev_code: null });
    }) as any;
    const out = await requestCode("https://auth.example", "i@x.com", fetchFn);
    expect(seen!.url).toBe("https://auth.example/auth/code");
    expect(seen!.body).toEqual({ email: "i@x.com" });
    expect(out).toEqual({}); // production: the code is emailed, nothing to surface
  });

  it("surfaces a dev_code when the server returns one", async () => {
    const fetchFn = (async () => jsonResponse({ sent: true, dev_code: "123456" })) as any;
    expect(await requestCode("https://a", "e@x.com", fetchFn)).toEqual({ devCode: "123456" });
  });

  it("throws with the status when the send fails", async () => {
    const fetchFn = (async () => new Response("no", { status: 429 })) as any;
    await expect(requestCode("https://a", "e@x.com", fetchFn)).rejects.toThrow(/429/);
  });
});

describe("verifyCode", () => {
  it("POSTs email+code to /auth/verify and returns the tokens", async () => {
    let seen: { url: string; body: any } | null = null;
    const fetchFn = (async (url: string, init: any) => {
      seen = { url, body: JSON.parse(init.body) };
      return jsonResponse({ access_token: mkJwt({ sub: "usr_1" }), refresh_token: "RT1" });
    }) as any;
    const t = await verifyCode("https://auth.example", "i@x.com", "454128", fetchFn);
    expect(seen!.url).toBe("https://auth.example/auth/verify");
    expect(seen!.body).toEqual({ email: "i@x.com", code: "454128" });
    expect(t.refreshToken).toBe("RT1");
    expect(t.accessToken).toMatch(/^eyJ/);
  });

  it("throws with the status on a rejected code", async () => {
    const fetchFn = (async () => new Response("bad code", { status: 401 })) as any;
    await expect(verifyCode("https://a", "e@x.com", "000000", fetchFn)).rejects.toThrow(/401/);
  });

  it("throws when the response carries no usable tokens", async () => {
    const noAccess = (async () => jsonResponse({ refresh_token: "RT" })) as any;
    await expect(verifyCode("https://a", "e@x.com", "1", noAccess)).rejects.toThrow(/access_token/);
    const noRefresh = (async () => jsonResponse({ access_token: mkJwt({ sub: "u" }) })) as any;
    await expect(verifyCode("https://a", "e@x.com", "1", noRefresh)).rejects.toThrow(/refresh_token/);
  });
});
