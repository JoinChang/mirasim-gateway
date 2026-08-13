import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const listFromEnv = (v: string | undefined): string[] | undefined =>
  v == null
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
const boolFrom = (v: unknown, dflt: boolean): boolean => (v == null ? dflt : /^(1|true|on|yes)$/i.test(String(v)));

const ConfigSchema = z.object({
  searchProvider: z.enum(["firecrawl", "serper", "searxng"]).default("firecrawl"),
  searchLimit: z.number().int().positive().default(5),
  maxConcurrency: z.number().int().positive().default(4),
  cooldownMs: z.number().int().positive().default(90_000),
  maxWaitMs: z.number().int().nonnegative().default(30_000),
  maxAttempts: z.number().int().positive().default(8),
  retry5xx: z.number().int().nonnegative().default(2),
  retry5xxDelayMs: z.number().int().nonnegative().default(500),
  emitCitations: z.boolean().default(true),
  minResultsBeforeFallback: z.number().int().nonnegative().default(2),
  deviceSigning: z.boolean().default(true),
  allowDomains: z.array(z.string()).default([]),
  preferDomains: z.array(z.string()).default([]),
  blockDomains: z.array(z.string()).default([]),
  modelAliases: z.record(z.string(), z.string()).default({}),
  defaultModel: z.string().default(""),
  modelProbeEnabled: z.boolean().default(true),
  modelProbeIntervalMs: z.number().int().positive().default(900_000),
  modelProbeTtlMs: z.number().int().positive().default(21_600_000),
  modelProbeMaxPerCycle: z.number().int().positive().default(8),
});

export interface AppConfig extends z.infer<typeof ConfigSchema> {
  appVersion: string;
  relayBase: string;
  loginBase: string;
  firecrawlKey: string | undefined;
  host: string;
  port: number;
  dataDir: string;
  masterKey: Buffer | null;
}

const stripSlash = (u: string) => u.replace(/\/+$/, "");

export function loadConfig(input: { fileJson: Record<string, unknown>; env: NodeJS.ProcessEnv }): AppConfig {
  const { fileJson, env } = input;
  // env overrides file for the validated block
  const merged: Record<string, unknown> = {
    ...fileJson,
    ...(env.SEARCH_PROVIDER ? { searchProvider: env.SEARCH_PROVIDER } : {}),
    ...(env.SEARCH_LIMIT ? { searchLimit: Number(env.SEARCH_LIMIT) } : {}),
    ...(env.MAX_CONCURRENCY ? { maxConcurrency: Number(env.MAX_CONCURRENCY) } : {}),
    ...(env.COOLDOWN_MS ? { cooldownMs: Number(env.COOLDOWN_MS) } : {}),
    ...(env.MAX_WAIT_MS ? { maxWaitMs: Number(env.MAX_WAIT_MS) } : {}),
    ...(env.MAX_ATTEMPTS ? { maxAttempts: Number(env.MAX_ATTEMPTS) } : {}),
    ...(env.RETRY_5XX ? { retry5xx: Number(env.RETRY_5XX) } : {}),
    ...(env.RETRY_5XX_DELAY_MS ? { retry5xxDelayMs: Number(env.RETRY_5XX_DELAY_MS) } : {}),
    ...(env.EMIT_CITATIONS != null ? { emitCitations: boolFrom(env.EMIT_CITATIONS, true) } : {}),
    ...(env.DEVICE_SIGNING != null ? { deviceSigning: boolFrom(env.DEVICE_SIGNING, true) } : {}),
    ...(listFromEnv(env.ALLOW_DOMAINS) ? { allowDomains: listFromEnv(env.ALLOW_DOMAINS) } : {}),
    ...(listFromEnv(env.PREFER_DOMAINS) ? { preferDomains: listFromEnv(env.PREFER_DOMAINS) } : {}),
    ...(listFromEnv(env.BLOCK_DOMAINS) ? { blockDomains: listFromEnv(env.BLOCK_DOMAINS) } : {}),
    ...(env.DEFAULT_MODEL ? { defaultModel: env.DEFAULT_MODEL } : {}),
    ...(env.MODEL_PROBE_ENABLED != null ? { modelProbeEnabled: boolFrom(env.MODEL_PROBE_ENABLED, true) } : {}),
    ...(env.MODEL_PROBE_INTERVAL_MS ? { modelProbeIntervalMs: Number(env.MODEL_PROBE_INTERVAL_MS) } : {}),
    ...(env.MODEL_PROBE_TTL_MS ? { modelProbeTtlMs: Number(env.MODEL_PROBE_TTL_MS) } : {}),
    ...(env.MODEL_PROBE_MAX_PER_CYCLE ? { modelProbeMaxPerCycle: Number(env.MODEL_PROBE_MAX_PER_CYCLE) } : {}),
  };
  const validated = ConfigSchema.parse(merged);

  const mk = (env.MIRASIM_MASTER_KEY ?? "").trim();
  const masterKey = /^[0-9a-fA-F]{64}$/.test(mk) ? Buffer.from(mk, "hex") : null;

  return {
    ...validated,
    appVersion: env.MIRASIM_APP_VERSION || "0.0.150",
    relayBase: stripSlash(env.MIRASIM_RELAY || "https://mirasim-relay.mirofish.ai"),
    loginBase: stripSlash(env.MIRASIM_LOGIN || "https://admin.test.mirofish.ai"),
    firecrawlKey: env.FIRECRAWL_API_KEY,
    host: env.HOST || "127.0.0.1",
    port: env.PORT ? Number(env.PORT) : 8788,
    dataDir: env.DATA_DIR || path.join(process.cwd(), "data"),
    masterKey,
  };
}

export function loadConfigFromDisk(dir = process.cwd()): AppConfig {
  const p = path.join(dir, "config.json");
  const fileJson = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  return loadConfig({ fileJson, env: process.env });
}
