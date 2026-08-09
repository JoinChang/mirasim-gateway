import type { SearchRow } from "../../types/wire.js";
export async function firecrawlSearch(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): Promise<SearchRow[]> {
  const key = env.FIRECRAWL_API_KEY;
  const url = (env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/+$/, "");
  const res = await fetchFn(`${url}/v2/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query, limit: limit * 2, sources: ["web"] }),
  });
  const j: any = await res.json().catch(() => ({}));
  const rows: any[] = j?.data?.web || j?.web || (Array.isArray(j?.data) ? j.data : []) || [];
  return rows.map((x) => ({ url: x.url, title: x.title || x.url, description: x.description || x.snippet || "" }));
}
