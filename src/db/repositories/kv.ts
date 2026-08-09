import { eq } from "drizzle-orm";
import type { DB } from "../client.js";
import { kv } from "../schema.js";

export function kvRepo(db: DB) {
  return {
    get(key: string): string | undefined {
      return db.select().from(kv).where(eq(kv.key, key)).get()?.value;
    },
    set(key: string, value: string): void {
      db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
    },
  };
}
export type KvRepo = ReturnType<typeof kvRepo>;
