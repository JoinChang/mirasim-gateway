import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "../client.js";
import { type UsageEvent, usageEvents } from "../schema.js";

/** Day or hour granularity for the time-bucketed queries. */
export type Bucket = "day" | "hour";

/**
 * The SQLite expression that names the local-time bucket a row falls in.
 *
 * `date(...)` yields `YYYY-MM-DD`; `strftime('%Y-%m-%dT%H', ...)` yields
 * `YYYY-MM-DDTHH`. Both match the ISO-string slice the usage page uses to line
 * each row up with an axis tick, so a day bucket and an hour bucket are read the
 * same way downstream. The `+N hours` modifier shifts the boundary onto the
 * operator's local clock.
 */
function bucketExpr(offsetHours: number, bucket: Bucket) {
  const shift = `${offsetHours >= 0 ? "+" : ""}${offsetHours} hours`;
  return bucket === "hour"
    ? sql<string>`strftime('%Y-%m-%dT%H', ${usageEvents.ts} / 1000, 'unixepoch', ${shift})`
    : sql<string>`date(${usageEvents.ts} / 1000, 'unixepoch', ${shift})`;
}

export function usageRepo(db: DB) {
  return {
    append(e: UsageEvent): void {
      db.insert(usageEvents).values(e).run();
    },
    /**
     * Per-bucket downstream traffic since sinceMs, bucketed by the operator's
     * local day (or hour — see bucketExpr). Each row: requests, how many
     * succeeded (2xx), total and cache-read input tokens, and total latency. Only
     * gateway requests reach usage_events — probes call the pool directly — so
     * these are real caller traffic. The window totals and the sparkline series
     * are both derived from this one query.
     */
    dailyStats(
      sinceMs: number,
      offsetHours = 0,
      bucket: Bucket = "day",
    ): {
      day: string;
      requests: number;
      ok: number;
      inputTokens: number;
      cachedInputTokens: number;
      latencyMsTotal: number;
    }[] {
      return db
        .select({
          day: bucketExpr(offsetHours, bucket),
          requests: sql<number>`count(*)`,
          ok: sql<number>`coalesce(sum(case when ${usageEvents.status} between 200 and 299 then 1 else 0 end), 0)`,
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
          cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)`,
          latencyMsTotal: sql<number>`coalesce(sum(${usageEvents.latencyMs}), 0)`,
        })
        .from(usageEvents)
        .where(gte(usageEvents.ts, sinceMs))
        .groupBy(sql`1`)
        .orderBy(sql`1`)
        .all();
    },
    /**
     * Tokens per bucket since sinceMs, oldest first, buckets with no traffic
     * omitted. Rows carrying no tokens are excluded so a bucket of
     * nothing-but-failures (a 429 or an empty response is recorded with zero
     * tokens) does not draw as a zero-height bar. Internal probes never reach
     * here — only gateway requests are recorded — so every row is real downstream
     * traffic either way.
     */
    dailyTokens(sinceMs: number, offsetHours = 0, bucket: Bucket = "day"): { day: string; tokens: number }[] {
      // Bucket by the operator's local day/hour, not UTC: the `+8 hours` modifier
      // shifts the boundary so 00:00–08:00 local traffic is not booked yesterday.
      return db
        .select({
          day: bucketExpr(offsetHours, bucket),
          tokens: sql<number>`sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens})`,
        })
        .from(usageEvents)
        .where(and(gte(usageEvents.ts, sinceMs), sql`${usageEvents.inputTokens} + ${usageEvents.outputTokens} > 0`))
        .groupBy(sql`1`)
        .orderBy(sql`1`)
        .all();
    },
    /**
     * Tokens per model since sinceMs, heaviest first. Same exclusion as
     * dailyTokens: rows carrying no tokens are probe traffic, not use.
     */
    modelTokens(sinceMs: number): { model: string; tokens: number }[] {
      return db
        .select({
          model: usageEvents.model,
          tokens: sql<number>`sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens})`,
        })
        .from(usageEvents)
        .where(and(gte(usageEvents.ts, sinceMs), sql`${usageEvents.inputTokens} + ${usageEvents.outputTokens} > 0`))
        .groupBy(usageEvents.model)
        .orderBy(sql`2 desc`)
        .all();
    },
    /** SUM(input+output) tokens for a downstream key since dayStartMs. */
    dailyTokensForKey(keyId: string, dayStartMs: number): number {
      const row = db
        .select({ total: sql<number>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)` })
        .from(usageEvents)
        .where(and(eq(usageEvents.downstreamKeyId, keyId), gte(usageEvents.ts, dayStartMs)))
        .get();
      return row?.total ?? 0;
    },
  };
}
export type UsageRepo = ReturnType<typeof usageRepo>;
