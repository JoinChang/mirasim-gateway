import { describe, expect, it } from "vitest";
import { fetchLimits } from "../../src/accounts/limits.js";
import { fakePool, R } from "../helpers/fakePool.js";

const LIMITS = {
  subject: "usr_1",
  suspended: false,
  unmetered: false,
  degraded: false,
  windows: [
    { name: "5h", used: 990.00724, budget: 26096, reset_at: 1787056409 },
    { name: "7d", used: 1062.235025, budget: 74560, reset_at: 1787577985 },
  ],
};

describe("fetchLimits", () => {
  it("asks each account by name — a pool-chosen account answers about the wrong one", async () => {
    const { pool, requests } = fakePool({ respond: () => R(LIMITS) });
    await fetchLimits(pool, ["a1", "a2", "a3"]);
    expect(requests.map((r) => r.onlyAccount)).toEqual(["a1", "a2", "a3"]);
  });

  it("costs no tokens: a GET with no body", async () => {
    const { pool, requests } = fakePool({ respond: () => R(LIMITS) });
    await fetchLimits(pool, ["a1"]);
    expect(requests[0]?.pathname).toBe("/v1/limits");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.body).toBeUndefined();
  });

  it("keeps money in cents and does not round the relay's fractions away", async () => {
    const { pool } = fakePool({ respond: () => R(LIMITS) });
    const [row] = await fetchLimits(pool, ["a1"]);
    expect(row).toMatchObject({ accountId: "a1", state: "ok", suspended: false });
    if (row?.state !== "ok") throw new Error("expected ok");
    expect(row.windows[0]).toEqual({
      name: "5h",
      usedCents: 990.00724,
      budgetCents: 26096,
      resetAt: 1787056409,
    });
  });

  it("reports full budget even when the account is 429 elsewhere — the shared pool is what is spent", async () => {
    // The case that motivated this command: `accounts check` calls these accounts
    // exhausted while their own windows have not been touched.
    const { pool } = fakePool({
      respond: () => R({ subject: "usr_2", windows: [{ name: "7d", used: 0, budget: 11667, reset_at: 1 }] }),
    });
    const [row] = await fetchLimits(pool, ["a1"]);
    if (row?.state !== "ok") throw new Error("expected ok");
    expect(row.windows[0]?.usedCents).toBe(0);
    expect(row.windows[0]?.budgetCents).toBe(11667);
  });

  it("carries the relay's error type through rather than a bare status", async () => {
    const { pool } = fakePool({ script: [() => R({ error: { type: "unauthorized" } }, 401)] });
    const [row] = await fetchLimits(pool, ["a1"]);
    expect(row).toEqual({ accountId: "a1", state: "error", status: 401, detail: "unauthorized" });
  });

  it("survives a throw rather than losing the accounts behind it", async () => {
    const { pool } = fakePool({
      script: [
        () => {
          throw new Error("socket hang up");
        },
        () => R(LIMITS),
      ],
    });
    const rows = await fetchLimits(pool, ["a1", "a2"]);
    expect(rows[0]).toMatchObject({ accountId: "a1", state: "error", status: 0 });
    expect(rows[1]?.state).toBe("ok");
  });

  it("treats an unparseable 200 as an error instead of inventing empty windows", async () => {
    const { pool } = fakePool({
      script: [() => new Response("<html>gateway</html>", { status: 200 })],
    });
    const [row] = await fetchLimits(pool, ["a1"]);
    expect(row).toMatchObject({ accountId: "a1", state: "error", detail: "unparseable body" });
  });
});
