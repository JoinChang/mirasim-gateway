import type { SearchRow } from "../../types/wire.js";
import { firecrawlSearch } from "./firecrawl.js";
import { searxngSearch } from "./searxng.js";
import { serperSearch } from "./serper.js";
export type SearchProvider = (
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
) => Promise<SearchRow[]>;
export const PROVIDERS: Record<string, SearchProvider> = {
  firecrawl: firecrawlSearch,
  serper: serperSearch,
  searxng: searxngSearch,
};
