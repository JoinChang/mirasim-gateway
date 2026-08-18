import { describe, expect, it } from "vitest";
import { chartAsset } from "../../src/gateway/chart-asset.js";

describe("chartAsset", () => {
  // Reaching into a package past its "exports" map is exactly the kind of path
  // that breaks on upgrade, and it would only surface on a request. So it is
  // resolved here rather than assumed.
  it("finds the UMD build chart.js does not export", () => {
    const bytes = chartAsset();
    expect(bytes.byteLength).toBeGreaterThan(50_000);
    expect(Buffer.from(bytes.subarray(0, 400)).toString("utf8")).toContain("Chart.js");
  });

  it("reads the file once", () => {
    expect(chartAsset()).toBe(chartAsset());
  });
});
