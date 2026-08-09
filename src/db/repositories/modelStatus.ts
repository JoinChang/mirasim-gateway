import { asc, eq, sql } from "drizzle-orm";
import type { DB } from "../client.js";
import { modelStatus } from "../schema.js";

export type ModelState = "ok" | "unavailable" | "unknown";
export type ModelStatusRow = typeof modelStatus.$inferSelect;

export function modelStatusRepo(db: DB) {
  return {
    get(model: string): ModelStatusRow | undefined {
      return db.select().from(modelStatus).where(eq(modelStatus.model, model)).get();
    },
    list(): ModelStatusRow[] {
      return db.select().from(modelStatus).orderBy(asc(modelStatus.model)).all();
    },
    markOk(model: string, at: number, fallbackTo: string | null): void {
      const row = { state: "ok", lastStatus: 200, lastCheckedAt: at, lastOkAt: at, servedModel: fallbackTo };
      db.insert(modelStatus)
        .values({ model, ...row, consecutiveFails: 0 })
        .onConflictDoUpdate({ target: modelStatus.model, set: { ...row, consecutiveFails: 0 } })
        .run();
    },
    markUnavailable(model: string, at: number, status: number): void {
      db.insert(modelStatus)
        .values({ model, state: "unavailable", lastStatus: status, lastCheckedAt: at, consecutiveFails: 1 })
        .onConflictDoUpdate({
          target: modelStatus.model,
          set: {
            state: "unavailable",
            lastStatus: status,
            lastCheckedAt: at,
            consecutiveFails: sql`${modelStatus.consecutiveFails} + 1`,
          },
        })
        .run();
    },
    /** Register models the relay advertises, without overwriting what we already learned. */
    seed(models: string[]): void {
      for (const model of models)
        db.insert(modelStatus).values({ model }).onConflictDoNothing({ target: modelStatus.model }).run();
    },
  };
}
export type ModelStatusRepo = ReturnType<typeof modelStatusRepo>;
