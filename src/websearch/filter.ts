import type { SearchRow } from "../types/wire.js";

export interface FilterCfg {
  allowDomains: string[];
  preferDomains: string[];
  blockDomains: string[];
  minResultsBeforeFallback: number;
  searchLimit: number;
}

export interface FilterHooks {
  /**
   * Fired when allowDomains was configured but discarded because too few results
   * matched. Worth surfacing: the allowlist silently stops applying exactly when
   * the query drifts off the list, which is when it would have mattered most.
   */
  onAllowFallback?: (kept: number) => void;
}

/** Config is hand-written, so tolerate case, a leading dot, and a www. prefix. */
const normDomain = (d: string): string =>
  d
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/^www\./, "");

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Exact host, or a subdomain of it. The leading dot is what stops evil-github.com. */
const matches = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

const TRACKING = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "spm",
  "si",
  "_hsenc",
  "_hsmi",
]);
const isTracking = (k: string) => k.startsWith("utm_") || TRACKING.has(k.toLowerCase());

/**
 * Identity of the *page*, not of the string. Search providers routinely return
 * the same page tagged with different campaign parameters; deduping on the raw
 * URL lets one page eat several of the searchLimit slots.
 *
 * Scheme is deliberately excluded (http and https of one page are one page) and
 * so is a `www.` host prefix. A trailing slash is only ignored at the root: `/x`
 * and `/x/` genuinely can be different pages, so those stay apart.
 */
const dedupeKey = (raw: string): string => {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (isTracking(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return raw;
  }
};

export function filterRows(rows: SearchRow[], cfg: FilterCfg, hooks?: FilterHooks): SearchRow[] {
  const allow = cfg.allowDomains.map(normDomain).filter(Boolean);
  const block = cfg.blockDomains.map(normDomain).filter(Boolean);
  const prefer = cfg.preferDomains.map(normDomain).filter(Boolean);

  // Resolve the host once per row, and drop anything that has no usable one —
  // a result the model cannot cite is only taking up a slot.
  const seen = new Set<string>();
  let out = rows
    .map((row) => ({ row, host: hostOf(row.url) }))
    .filter(({ row, host }) => {
      if (!row.url || !host) return false;
      const key = dedupeKey(row.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  out = out.filter(({ host }) => !block.some((d) => matches(host, d)));

  if (allow.length) {
    const inAllow = out.filter(({ host }) => allow.some((d) => matches(host, d)));
    if (inAllow.length >= cfg.minResultsBeforeFallback) out = inAllow;
    else hooks?.onAllowFallback?.(inAllow.length);
  }

  if (prefer.length) {
    const score = (host: string) => (prefer.some((d) => matches(host, d)) ? 0 : 1);
    out = out
      .map((e, i) => [e, i] as const)
      .sort((a, b) => score(a[0].host) - score(b[0].host) || a[1] - b[1])
      .map(([e]) => e);
  }

  return out.slice(0, cfg.searchLimit).map(({ row }) => row);
}
