import { describe, expect, it } from "vitest";
import { filterRows } from "../../src/websearch/filter.js";

const R = (u: string) => ({ url: u, title: u, description: "" });
const base = { allowDomains: [], preferDomains: [], blockDomains: [], minResultsBeforeFallback: 2, searchLimit: 5 };
describe("filterRows", () => {
  it("dedupes by url", () => {
    expect(filterRows([R("http://a.com/1"), R("http://a.com/1")], base)).toHaveLength(1);
  });
  it("drops blocked domains", () => {
    expect(
      filterRows([R("http://x.com"), R("http://y.com")], { ...base, blockDomains: ["x.com"] }).map((r) => r.url),
    ).toEqual(["http://y.com"]);
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
