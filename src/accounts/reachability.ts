import type { Pool } from "./pool.js";

export type Reach =
  | { accountId: string; state: "ok"; models: number }
  | { accountId: string; state: "exhausted"; status: number }
  | { accountId: string; state: "error"; status: number; detail: string };

/**
 * Can the relay serve this account right now?
 *
 * Asked with `GET /v1/models`, which costs no tokens and is behind the same
 * shared-budget gate as everything else — during the August outage it returned
 * the identical `credit_exhausted_shared`. That makes it the cheapest possible
 * recovery probe, and the catalogue it returns on success is worth having anyway.
 *
 * Per account, not per relay: the operator said restoration is gradual, a
 * thousand users at a time, so "the relay is back" is not one fact. Each account
 * is pinned with `onlyAccount` — letting the pool choose would report on
 * whichever account it liked and hide the other four.
 */
export async function checkReachability(pool: Pool, accountIds: string[]): Promise<Reach[]> {
  const out: Reach[] = [];
  for (const accountId of accountIds) {
    try {
      const { response } = await pool.execute({
        kind: "chat",
        pathname: "/v1/models",
        method: "GET",
        onlyAccount: accountId,
      });
      const text = await response.text().catch(() => "");
      if (response.ok) {
        let models = 0;
        try {
          const j = JSON.parse(text);
          models = Array.isArray(j?.data) ? j.data.length : 0;
        } catch {}
        out.push({ accountId, state: "ok", models });
        continue;
      }
      let type = "";
      try {
        type = JSON.parse(text)?.error?.type ?? "";
      } catch {}
      if (type === "credit_exhausted_shared" || type === "shared_quota_unavailable")
        out.push({ accountId, state: "exhausted", status: response.status });
      else out.push({ accountId, state: "error", status: response.status, detail: type || text.slice(0, 120) });
    } catch (e) {
      out.push({ accountId, state: "error", status: 0, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
