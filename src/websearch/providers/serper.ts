import type { SearchRow } from "../../types/wire.js";
export async function serperSearch(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): Promise<SearchRow[]> {
  const res = await fetchFn("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify({ q: query, num: limit * 2 }),
  });
  const j: any = await res.json().catch(() => ({}));
  return (j.organic || []).map((x: any) => ({ url: x.link, title: x.title, description: x.snippet || "" }));
}
