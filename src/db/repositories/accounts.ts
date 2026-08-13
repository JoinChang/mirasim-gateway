import { asc, eq } from "drizzle-orm";
import type { DB } from "../client.js";
import { type Account, accounts, type NewAccount } from "../schema.js";

export function accountsRepo(db: DB) {
  return {
    upsert(rec: NewAccount): void {
      db.insert(accounts).values(rec).onConflictDoUpdate({ target: accounts.id, set: rec }).run();
    },
    get(id: string): Account | undefined {
      return db.select().from(accounts).where(eq(accounts.id, id)).get();
    },
    list(): Account[] {
      return db.select().from(accounts).orderBy(asc(accounts.createdAt)).all();
    },
    remove(id: string): void {
      db.delete(accounts).where(eq(accounts.id, id)).run();
    },
    setDisabledUntil(id: string, ms: number): void {
      db.update(accounts).set({ disabledUntil: ms }).where(eq(accounts.id, id)).run();
    },
    setUtilization(id: string, u: number): void {
      db.update(accounts).set({ lastUtilization: u }).where(eq(accounts.id, id)).run();
    },
    setLastUsed(id: string, ms: number): void {
      db.update(accounts).set({ lastUsedAt: ms }).where(eq(accounts.id, id)).run();
    },
    setFails(id: string, n: number): void {
      db.update(accounts).set({ consecutiveFails: n }).where(eq(accounts.id, id)).run();
    },
    setProfile(id: string, p: { email?: string; plan?: string }): void {
      const set: Record<string, string> = {};
      if (p.email) set.email = p.email;
      if (p.plan) set.plan = p.plan;
      if (Object.keys(set).length) db.update(accounts).set(set).where(eq(accounts.id, id)).run();
    },
    setRefreshToken(id: string, token: string): void {
      db.update(accounts).set({ refreshToken: token }).where(eq(accounts.id, id)).run();
    },
    setDeviceKey(id: string, pem: string): void {
      db.update(accounts).set({ devicePrivateKey: pem }).where(eq(accounts.id, id)).run();
    },
  };
}
export type AccountsRepo = ReturnType<typeof accountsRepo>;
