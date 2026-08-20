import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "../client.js";
import { type UsageEvent, usageEvents } from "../schema.js";

export function usageRepo(db: DB) {
  return {
    append(e: UsageEvent): void {
      db.insert(usageEvents).values(e).run();
    },
    /**
     * Tokens per UTC day since sinceMs, oldest first, days with no traffic
     * omitted. Rows carrying no tokens are excluded rather than counted as a
     * zero-token day: the internal reachability probes land here too, and a
     * probe is not a day of use.
     */
    dailyTokens(sinceMs: number, offsetHours = 0): { day: string; tokens: number }[] {
      // Bucket by the operator's local day, not UTC: `date(..., '+8 hours')`
      // shifts the boundary so 00:00–08:00 local traffic is not booked yesterday.
      const shift = `${offsetHours >= 0 ? "+" : ""}${offsetHours} hours`;
      return db
        .select({
          day: sql<string>`date(${usageEvents.ts} / 1000, 'unixepoch', ${shift})`,
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
