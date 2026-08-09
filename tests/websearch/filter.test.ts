import { describe, expect, it, vi } from "vitest";
import { filterRows } from "../../src/websearch/filter.js";

const R = (u: string) => ({ url: u, title: u, description: "" });
const base = { allowDomains: [], preferDomains: [], blockDomains: [], minResultsBeforeFallback: 2, searchLimit: 5 };
const urls = (rows: { url: string }[]) => rows.map((r) => r.url);

describe("filterRows", () => {
  it("dedupes by url", () => {
    expect(filterRows([R("http://a.com/1"), R("http://a.com/1")], base)).toHaveLength(1);
  });
  it("drops blocked domains", () => {
    expect(urls(filterRows([R("http://x.com"), R("http://y.com")], { ...base, blockDomains: ["x.com"] }))).toEqual([
      "http://y.com",
    ]);
  });
  it("allow keeps only allowed when enough survive", () => {
    const rows = [R("http://ok.com/1"), R("http://ok.com/2"), R("http://junk.com")];
    expect(filterRows(rows, { ...base, allowDomains: ["ok.com"] }).every((r) => r.url.includes("ok.com"))).toBe(true);
  });
  it("allow falls back when too few survive", () => {
    const rows = [R("http://ok.com/1"), R("http://junk.com")];
    expect(filterRows(rows, { ...base, allowDomains: ["ok.com"], minResultsBeforeFallback: 2 })).toHaveLength(2);
  });
  it("prefer reranks to front (stable)", () => {
    const rows = [R("http://z.com"), R("http://pref.com"), R("http://y.com")];
    expect(filterRows(rows, { ...base, preferDomains: ["pref.com"] })[0]!.url).toBe("http://pref.com");
  });
});

describe("lookalike domains stay out", () => {
  const cfg = { ...base, allowDomains: ["github.com"], minResultsBeforeFallback: 1 };
  it("matches the domain and its subdomains, nothing that merely ends in the same letters", () => {
    const rows = [
      R("https://github.com/a"),
      R("https://docs.github.com/b"),
      R("https://evil-github.com/c"),
      R("https://github.com.evil.net/d"),
      R("https://github.com.br/e"),
    ];
    expect(urls(filterRows(rows, cfg))).toEqual(["https://github.com/a", "https://docs.github.com/b"]);
  });
});

describe("domain config is normalised, so a stray capital or www is not a dead entry", () => {
  const rows = [R("https://example.com/a"), R("https://www.example.com/b"), R("https://junk.test/c")];
  const run = (allowDomains: string[]) =>
    urls(filterRows(rows, { ...base, allowDomains, minResultsBeforeFallback: 1 }));

  it("accepts mixed case", () => {
    expect(run(["Example.COM"])).toEqual(["https://example.com/a", "https://www.example.com/b"]);
  });
  it("accepts a www. prefix", () => {
    expect(run(["www.example.com"])).toEqual(["https://example.com/a", "https://www.example.com/b"]);
  });
  it("accepts a leading dot", () => {
    expect(run([".example.com"])).toEqual(["https://example.com/a", "https://www.example.com/b"]);
  });
  it("ignores blank entries", () => {
    expect(run(["", "  ", "example.com"])).toEqual(["https://example.com/a", "https://www.example.com/b"]);
  });
});

describe("dedupe survives cosmetic url differences", () => {
  const keep = (us: string[]) => urls(filterRows(us.map(R), base));

  it("collapses tracking parameters onto the first sighting", () => {
    expect(keep(["https://a.com/x", "https://a.com/x?utm_source=news", "https://a.com/x?fbclid=123"])).toEqual([
      "https://a.com/x",
    ]);
  });
  it("collapses fragments", () => {
    expect(keep(["https://a.com/x", "https://a.com/x#section"])).toEqual(["https://a.com/x"]);
  });
  it("collapses a bare host against its root slash", () => {
    expect(keep(["https://a.com", "https://a.com/"])).toEqual(["https://a.com"]);
  });
  it("collapses www against the bare host", () => {
    expect(keep(["https://a.com/x", "https://www.a.com/x"])).toEqual(["https://a.com/x"]);
  });
  it("keeps genuinely different query strings apart", () => {
    expect(keep(["https://a.com/s?q=cats", "https://a.com/s?q=dogs"])).toHaveLength(2);
  });
  it("keeps a trailing slash on a deep path apart, since those can differ", () => {
    expect(keep(["https://a.com/x", "https://a.com/x/"])).toHaveLength(2);
  });
});

describe("results without a usable url are dropped", () => {
  it("drops unparseable and hostless urls", () => {
    const rows = [R("javascript:alert(1)"), R("not a url"), R("https://real.test/x")];
    expect(urls(filterRows(rows, base))).toEqual(["https://real.test/x"]);
  });
});

describe("the allowlist says when it gave up", () => {
  it("reports the fallback, with how many results had survived", () => {
    const onAllowFallback = vi.fn();
    filterRows(
      [R("http://ok.com/1"), R("http://junk.com")],
      { ...base, allowDomains: ["ok.com"] },
      { onAllowFallback },
    );
    expect(onAllowFallback).toHaveBeenCalledWith(1);
  });
  it("stays quiet when the allowlist held", () => {
    const onAllowFallback = vi.fn();
    filterRows(
      [R("http://ok.com/1"), R("http://ok.com/2"), R("http://junk.com")],
      { ...base, allowDomains: ["ok.com"] },
      { onAllowFallback },
    );
    expect(onAllowFallback).not.toHaveBeenCalled();
  });
  it("stays quiet when no allowlist is configured", () => {
    const onAllowFallback = vi.fn();
    filterRows([R("http://junk.com")], base, { onAllowFallback });
    expect(onAllowFallback).not.toHaveBeenCalled();
  });
});
