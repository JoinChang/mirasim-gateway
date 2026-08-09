import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "../client.js";
import { type UsageEvent, usageEvents } from "../schema.js";

export function usageRepo(db: DB) {
  return {
    append(e: UsageEvent): void {
      db.insert(usageEvents).values(e).run();
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
