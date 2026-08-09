export interface ProbeCandidate {
  model: string;
  state: string;
  lastCheckedAt: number;
}

export interface ProbeSelection {
  ttlMs: number;
  max: number;
}

/**
 * Pick the models worth spending a probe on this cycle.
 *
 * Models already carrying a fresh verdict are skipped — real traffic keeps those
 * current for free. What needs an active probe is the long tail nobody calls:
 * models never checked, and verdicts old enough to have gone stale (a dead model
 * may have come back, a working one may have gone away).
 */
export function selectProbeTargets(rows: ProbeCandidate[], now: number, opts: ProbeSelection): string[] {
  return rows
    .filter((r) => now - r.lastCheckedAt >= opts.ttlMs)
    .sort((a, b) => {
      const unchecked = (r: ProbeCandidate) => (r.state === "unknown" || r.lastCheckedAt === 0 ? 0 : 1);
      return unchecked(a) - unchecked(b) || a.lastCheckedAt - b.lastCheckedAt || a.model.localeCompare(b.model);
    })
    .slice(0, opts.max)
    .map((r) => r.model);
}
