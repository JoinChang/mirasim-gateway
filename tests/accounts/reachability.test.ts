import { describe, expect, it } from "vitest";
import { checkReachability } from "../../src/accounts/reachability.js";
import { fakePool, R } from "../helpers/fakePool.js";

const EXHAUSTED = { type: "error", error: { type: "credit_exhausted_shared", message: "…" } };

describe("checkReachability", () => {
  it("asks about each account by name — restoration is per user, not per relay", async () => {
    const { pool, requests } = fakePool({ respond: () => R({ data: [{ id: "claude-opus-5" }] }) });
    const rows = await checkReachability(pool, ["a1", "a2", "a3"]);
    expect(requests.map((r) => r.onlyAccount)).toEqual(["a1", "a2", "a3"]);
    // Pinning matters: without it the pool answers about whichever account it
    // picked and the other two go unreported.
    expect(rows.every((r) => r.state === "ok")).toBe(true);
  });

  it("costs no tokens — it asks the catalogue, which is behind the same gate", async () => {
    const { pool, requests } = fakePool({ respond: () => R({ data: [] }) });
    await checkReachability(pool, ["a1"]);
    expect(requests[0]?.pathname).toBe("/v1/models");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.body).toBeUndefined();
  });

  it("separates a spent shared budget from a real failure", async () => {
    const { pool } = fakePool({
      script: [() => R(EXHAUSTED, 429), () => R({ error: { type: "unauthorized" } }, 401)],
    });
    const rows = await checkReachability(pool, ["a1", "a2"]);
    expect(rows[0]).toEqual({ accountId: "a1", state: "exhausted", status: 429 });
    expect(rows[1]).toMatchObject({ accountId: "a2", state: "error", status: 401 });
  });

  it("reports a mixed pool, which is what a gradual restoration looks like", async () => {
    const { pool } = fakePool({
      script: [() => R(EXHAUSTED, 429), () => R({ data: [{ id: "m1" }, { id: "m2" }] }), () => R(EXHAUSTED, 429)],
    });
    const rows = await checkReachability(pool, ["a1", "a2", "a3"]);
    expect(rows.map((r) => r.state)).toEqual(["exhausted", "ok", "exhausted"]);
    expect(rows[1]).toEqual({ accountId: "a2", state: "ok", models: 2 });
  });

  it("survives a throw rather than losing the accounts behind it", async () => {
    const { pool } = fakePool({
      script: [
        () => {
          throw new Error("socket hang up");
        },
        () => R({ data: [] }),
      ],
    });
    const rows = await checkReachability(pool, ["a1", "a2"]);
    expect(rows[0]).toMatchObject({ accountId: "a1", state: "error", detail: "socket hang up" });
    expect(rows[1]?.state).toBe("ok");
  });
});
