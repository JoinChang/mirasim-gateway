import type { Pool } from "./pool.js";

/** One budget window as the relay reports it. Money is in cents. */
export interface LimitWindow {
  /** The relay's own label: "5h", "7d", "30d". Which windows exist varies by plan. */
  name: string;
  usedCents: number;
  budgetCents: number;
  resetAt: number;
}

export type Limits =
  | {
      accountId: string;
      state: "ok";
      suspended: boolean;
      unmetered: boolean;
      degraded: boolean;
      windows: LimitWindow[];
    }
  | { accountId: string; state: "error"; status: number; detail: string };

/**
 * What is left of each account's own budget, asked with `GET /v1/limits`.
 *
 * This answers a different question from `checkReachability`, and the two
 * disagree in a way that matters: an account can report `exhausted` there while
 * every window here is at 0% used. That is not a contradiction — a 429 carrying
 * `credit_exhausted_shared` means the *relay's* shared budget is spent, not this
 * account's. Reading it as "the account is out" cooled five healthy accounts for
 * four days once. Ask this when the question is "how much is left", and keep
 * `accounts check` for "can it serve right now".
 *
 * Pinned per account with `onlyAccount` for the same reason reachability is: the
 * pool would otherwise answer about whichever account it felt like.
 */
export async function fetchLimits(pool: Pool, accountIds: string[]): Promise<Limits[]> {
  const out: Limits[] = [];
  for (const accountId of accountIds) {
    try {
      const { response } = await pool.execute({
        kind: "messages",
        pathname: "/v1/limits",
        method: "GET",
        onlyAccount: accountId,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        let type = "";
        try {
          type = JSON.parse(text)?.error?.type ?? "";
        } catch {}
        out.push({ accountId, state: "error", status: response.status, detail: type || text.slice(0, 120) });
        continue;
      }
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        out.push({ accountId, state: "error", status: response.status, detail: "unparseable body" });
        continue;
      }
      out.push({
        accountId,
        state: "ok",
        suspended: Boolean(body?.suspended),
        unmetered: Boolean(body?.unmetered),
        degraded: Boolean(body?.degraded),
        windows: (Array.isArray(body?.windows) ? body.windows : []).map((w: any) => ({
          name: String(w?.name ?? "?"),
          usedCents: Number(w?.used ?? 0),
          budgetCents: Number(w?.budget ?? 0),
          resetAt: Number(w?.reset_at ?? 0),
        })),
      });
    } catch (e) {
      out.push({ accountId, state: "error", status: 0, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
