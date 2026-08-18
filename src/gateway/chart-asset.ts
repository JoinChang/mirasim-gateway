import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Chart.js, served by us rather than from a CDN.
 *
 * The usage page is public, so a CDN tag would send every visitor to a third
 * party just to look at a bar chart, and would break the page whenever that
 * host is unreachable. node_modules ships in the runtime image, so resolving it
 * here works the same in dev and in the container.
 *
 * The UMD build is the one that defines a global for a plain <script> tag, and
 * chart.js does not list it in "exports" — so the path is reached from a subpath
 * that is exported, rather than asked for directly.
 */
let cached: Uint8Array | null = null;

export function chartAsset(): Uint8Array {
  if (!cached) {
    const require = createRequire(import.meta.url);
    const pkgRoot = dirname(dirname(require.resolve("chart.js/auto")));
    cached = new Uint8Array(readFileSync(join(pkgRoot, "dist", "chart.umd.js")));
  }
  return cached;
}
