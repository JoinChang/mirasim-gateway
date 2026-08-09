import path from "node:path";
import { createPool } from "./accounts/pool.js";
import { createRefresher } from "./accounts/refresh.js";
import { accountStore } from "./accounts/store.js";
import { createTicketManager } from "./accounts/ticket.js";
import type { AppConfig } from "./config/index.js";
import { type DB, openDb, migrate as runMigrate } from "./db/client.js";
import { accountsRepo } from "./db/repositories/accounts.js";
import { keysRepo } from "./db/repositories/keys.js";
import { usageRepo } from "./db/repositories/usage.js";
import { createApp } from "./gateway/app.js";
import { createMetrics } from "./metrics/registry.js";
import { makeSemaphore } from "./upstream/sem.js";
import { createRecorder } from "./usage/recorder.js";
import { makeSearch } from "./websearch/search.js";

export function buildRuntime(cfg: AppConfig, dbPath?: string) {
  const db: DB = openDb(dbPath ?? path.join(cfg.dataDir, "gateway.db"));
  runMigrate(db);
  const store = accountStore({ db, masterKey: cfg.masterKey });
  const keys = keysRepo(db);
  const usage = usageRepo(db);
  const accounts = accountsRepo(db);
  const metrics = createMetrics();
  const recorder = createRecorder({ usage, keys, accounts, metrics });
  const refresher = createRefresher({ store, loginBase: cfg.loginBase, fetchFn: fetch });
  const ticketManager = createTicketManager({ relayBase: cfg.relayBase, fetchFn: fetch, appVersion: cfg.appVersion });
  const sem = makeSemaphore(cfg.maxConcurrency);
  const pool = createPool({ store, refresher, ticketManager, config: cfg, sem, fetchFn: fetch });
  const search = makeSearch(cfg, process.env, fetch);
  const app = createApp({ pool, store, cfg, keys, usage, metrics, recorder, search });
  return { db, store, keys, usage, metrics, pool, app };
}
