import type { SearchRow } from "../types/wire.js";

export interface FilterCfg {
  allowDomains: string[];
  preferDomains: string[];
  blockDomains: string[];
  minResultsBeforeFallback: number;
  searchLimit: number;
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const matches = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

export function filterRows(rows: SearchRow[], cfg: FilterCfg): SearchRow[] {
  // dedupe by url
  const seen = new Set<string>();
  let out = rows.filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  // block
  out = out.filter((r) => {
    const h = hostOf(r.url);
    return !cfg.blockDomains.some((d) => matches(h, d));
  });
  // allow (with fallback if too few survive)
  if (cfg.allowDomains.length) {
    const inAllow = out.filter((r) => {
      const h = hostOf(r.url);
      return cfg.allowDomains.some((d) => matches(h, d));
    });
    if (inAllow.length >= cfg.minResultsBeforeFallback) out = inAllow;
  }
  // prefer (soft, stable rerank)
  if (cfg.preferDomains.length) {
    const score = (r: SearchRow) => (cfg.preferDomains.some((d) => matches(hostOf(r.url), d)) ? 0 : 1);
    out = out
      .map((r, i) => [r, i] as const)
      .sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1])
      .map(([r]) => r);
  }
  return out.slice(0, cfg.searchLimit);
}
