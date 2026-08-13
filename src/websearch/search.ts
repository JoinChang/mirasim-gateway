import type { AppConfig } from "../config/index.js";
import type { SearchRow } from "../types/wire.js";
import { type FilterHooks, filterRows } from "./filter.js";
import { PROVIDERS } from "./providers/index.js";

export function makeSearch(
  cfg: AppConfig,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  hooks?: FilterHooks,
): (query: string) => Promise<SearchRow[]> {
  const provider = PROVIDERS[cfg.searchProvider] ?? PROVIDERS.firecrawl!;
  return async (query: string) => {
    const raw = await provider(query, cfg.searchLimit, env, fetchFn).catch(() => []);
    return filterRows(raw, cfg, hooks);
  };
}
