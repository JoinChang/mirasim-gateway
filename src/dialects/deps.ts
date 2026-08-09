import type { Pool } from "../accounts/pool.js";
import type { AppConfig } from "../config/index.js";
import type { SearchRow } from "../types/wire.js";

export interface DialectDeps {
  pool: Pool;
  cfg: AppConfig;
  search: (query: string) => Promise<SearchRow[]>;
}
