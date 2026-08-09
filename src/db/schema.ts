import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  email: text("email").notNull().default(""),
  plan: text("plan").notNull().default(""),
  refreshToken: text("refresh_token").notNull(),
  devicePrivateKey: text("device_private_key"),
  disabledUntil: integer("disabled_until").notNull().default(0),
  consecutiveFails: integer("consecutive_fails").notNull().default(0),
  lastUsedAt: integer("last_used_at").notNull().default(0),
  lastUtilization: real("last_utilization").notNull().default(0),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const downstreamKeys = sqliteTable("downstream_keys", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  rpmLimit: integer("rpm_limit"),
  dailyTokenLimit: integer("daily_token_limit"),
  lastUsedAt: integer("last_used_at").notNull().default(0),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const usageEvents = sqliteTable("usage_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  downstreamKeyId: text("downstream_key_id"),
  accountId: text("account_id"),
  dialect: text("dialect").notNull(),
  model: text("model").notNull().default(""),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  webSearchRequests: integer("web_search_requests").notNull().default(0),
  status: integer("status").notNull().default(0),
  viaRelay: integer("via_relay").notNull().default(0),
  cost: real("cost"),
  latencyMs: integer("latency_ms").notNull().default(0),
});

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  actor: text("actor").notNull().default("cli"),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type DownstreamKey = typeof downstreamKeys.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferInsert;
