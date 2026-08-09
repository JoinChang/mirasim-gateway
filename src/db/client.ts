import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function migrate(db: DB): void {
  drizzleMigrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/** Convenience for tests: in-memory db with migrations applied. */
export function memDb(): DB {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

export { schema };
