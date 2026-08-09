import { asc, eq } from "drizzle-orm";
import type { DB } from "../client.js";
import { type DownstreamKey, downstreamKeys } from "../schema.js";

export function keysRepo(db: DB) {
  return {
    create(rec: {
      id: string;
      keyHash: string;
      label: string;
      rpmLimit?: number | null;
      dailyTokenLimit?: number | null;
    }): void {
      db.insert(downstreamKeys)
        .values({
          id: rec.id,
          keyHash: rec.keyHash,
          label: rec.label,
          rpmLimit: rec.rpmLimit ?? null,
          dailyTokenLimit: rec.dailyTokenLimit ?? null,
        })
        .run();
    },
    findByHash(hash: string): DownstreamKey | undefined {
      return db.select().from(downstreamKeys).where(eq(downstreamKeys.keyHash, hash)).get();
    },
    list(): DownstreamKey[] {
      return db.select().from(downstreamKeys).orderBy(asc(downstreamKeys.createdAt)).all();
    },
    count(): number {
      return db.select().from(downstreamKeys).all().length;
    },
    revoke(id: string): void {
      db.update(downstreamKeys).set({ enabled: 0 }).where(eq(downstreamKeys.id, id)).run();
    },
    touch(id: string, ms: number): void {
      db.update(downstreamKeys).set({ lastUsedAt: ms }).where(eq(downstreamKeys.id, id)).run();
    },
  };
}
export type KeysRepo = ReturnType<typeof keysRepo>;
