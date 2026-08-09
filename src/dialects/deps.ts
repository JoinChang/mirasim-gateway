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
): Promise<{ status: number; json: any }> {
  const { response } = await pool.execute(kind, (call) => call(pathname, body), (body as any)?.model);
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}
