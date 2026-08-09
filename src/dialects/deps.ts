import type { Pool } from "../accounts/pool.js";
import type { AppConfig } from "../config/index.js";
import type { SearchRow } from "../types/wire.js";

export interface DialectDeps {
  pool: Pool;
  cfg: AppConfig;
  search: (query: string) => Promise<SearchRow[]>;
}

/** Read a relay response as parsed JSON + status (for loop hops). */
export async function hopJson(
  pool: Pool,
  kind: "messages" | "chat" | "responses",
  pathname: string,
  body: unknown,
  betas?: string,
): Promise<{ status: number; json: any; accountId: string }> {
  const { response, accountId } = await pool.execute({ kind, pathname, body, model: (body as any)?.model, betas });
  const json = await response.json().catch(() => null);
  return { status: response.status, json, accountId };
}
