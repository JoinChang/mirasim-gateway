import type { SearchRow } from "../../types/wire.js";
export async function searxngSearch(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): Promise<SearchRow[]> {
  const base = (env.SEARXNG_URL || "").replace(/\/+$/, "");
  const res = await fetchFn(`${base}/search?q=${encodeURIComponent(query)}&format=json`);
  const j: any = await res.json().catch(() => ({}));
  return (j.results || [])
    .slice(0, limit * 2)
    .map((x: any) => ({ url: x.url, title: x.title, description: x.content || "" }));
}
