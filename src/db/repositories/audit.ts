import { desc } from "drizzle-orm";
import type { DB } from "../client.js";
import { auditLog } from "../schema.js";

export function auditRepo(db: DB) {
  return {
    append(action: string, detail = "", actor = "cli"): void {
      db.insert(auditLog).values({ ts: Date.now(), action, detail, actor }).run();
    },
    recent(limit = 50) {
      return db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all();
    },
  };
}
export type AuditRepo = ReturnType<typeof auditRepo>;
