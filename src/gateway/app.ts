import { type Context, Hono } from "hono";
import type { Pool } from "../accounts/pool.js";
import type { AccountStore } from "../accounts/store.js";
import type { AppConfig } from "../config/index.js";
import type { KeysRepo } from "../db/repositories/keys.js";
import type { ModelStatusRepo } from "../db/repositories/modelStatus.js";
import type { UsageRepo } from "../db/repositories/usage.js";
import type { DownstreamKey } from "../db/schema.js";
import { messagesDialect } from "../dialects/anthropic.js";
import { chatDialect } from "../dialects/openai-chat.js";
import { responsesDialect } from "../dialects/openai-responses.js";
import { type DialectSpec, runDialect } from "../dialects/run.js";
import type { Metrics } from "../metrics/registry.js";
import type { GatewayResult, SearchRow } from "../types/wire.js";
import { HOP_BY_HOP } from "../upstream/relay.js";
import type { Recorder } from "../usage/recorder.js";
import { chartAsset } from "./chart-asset.js";
import { explainRelayError } from "./relayErrors.js";
import { meterStream } from "./streamUsage.js";
import { createUsageSource, parseRange, renderUsagePage } from "./usage-page.js";
import { applyModelAlias, sha256Hex, utcDayStartMs } from "./util.js";

type Vars = { key?: DownstreamKey; openMode?: boolean };

export interface AppDeps {
  pool: Pool;
  store: AccountStore;
  cfg: AppConfig;
  keys: KeysRepo;
  usage: UsageRepo;
  metrics: Metrics;
  recorder: Recorder;
  search: (query: string) => Promise<SearchRow[]>;
  modelStatus: ModelStatusRepo;
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  const { cfg } = deps;

  // ---- downstream auth ----
  app.use("/v1/*", async (c, next) => {
    if (deps.keys.count() === 0) {
      c.set("openMode", true);
      return next();
    }
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    const key = (m?.[1] ?? c.req.header("x-api-key") ?? "").trim();
    if (!key) return c.json({ error: { type: "unauthorized", message: "missing api key" } }, 401);
    const row = deps.keys.findByHash(sha256Hex(key));
    if (!row?.enabled) return c.json({ error: { type: "unauthorized", message: "invalid api key" } }, 401);
    c.set("key", row);
    return next();
  });

  // ---- per-key rate limit / daily token quota ----
  const buckets = new Map<string, { count: number; windowStart: number }>();
  app.use("/v1/*", async (c, next) => {
    const key = c.get("key");
    if (!key) return next();
    const now = Date.now();
    if (key.rpmLimit) {
      const b = buckets.get(key.id) ?? { count: 0, windowStart: now };
      if (now - b.windowStart >= 60_000) {
        b.count = 0;
        b.windowStart = now;
      }
      b.count++;
      buckets.set(key.id, b);
      if (b.count > key.rpmLimit) return c.json({ error: { type: "rate_limit", message: "rpm limit exceeded" } }, 429);
    }
    if (key.dailyTokenLimit && deps.usage.dailyTokensForKey(key.id, utcDayStartMs(now)) >= key.dailyTokenLimit)
      return c.json({ error: { type: "rate_limit", message: "daily token limit exceeded" } }, 429);
    return next();
  });

  const finish = (c: any, result: GatewayResult, dialect: string, model: string, started: number): Response => {
    const keyId = c.get("key")?.id ?? null;
    const rec = (
      status: number,
      accountId: string | null,
      u: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        webSearchRequests: number;
        cost: number | null;
      },
    ) =>
      deps.recorder.record({
        downstreamKeyId: keyId,
        accountId,
        dialect,
        model,
        ...u,
        status,
        viaRelay: true,
        latencyMs: Date.now() - started,
      });
    // Whoever ran the request measured it; there is no second source to reconcile.
    if (result.type === "json") {
      rec(result.status, result.accountId ?? null, { ...result.usage, cost: null });
      // The relay describes its own exhausted capacity as an auth failure; say
      // what it actually means before the client renders "failed to authenticate".
      const explained = explainRelayError(result.status, result.json);
      if (explained) deps.metrics.relayExhausted.inc();
      return c.json(explained ?? result.json, result.status);
    }
    if (result.type === "sse") {
      rec(result.status ?? 200, result.accountId ?? null, { ...result.usage, cost: null });
      return new Response(result.text, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }
    const headers = new Headers();
    result.response.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    });
    // Metered as the body streams past: recording zero here would exempt every
    // streaming client from downstream key quotas, and streaming is the norm. A
    // stream that opened 200 and then carried an error frame is booked as the
    // upstream failure it was (502), not a served request — the tokens still
    // count, since the relay consumed them before it failed.
    const record = (u: { inputTokens: number; outputTokens: number; cachedInputTokens: number; error?: string }) =>
      rec(u.error !== undefined ? 502 : result.response.status, result.accountId ?? null, {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        webSearchRequests: 0,
        cost: null,
      });
    if (!result.response.body) {
      record({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
      return new Response(null, { status: result.response.status, headers });
    }
    return new Response(meterStream(result.response.body, record), {
      status: result.response.status,
      headers,
    });
  };

  // The spec carries its own kind and pathnames, so the route table no longer
  // repeats either of them.
  const route = (spec: DialectSpec) => {
    const handler = async (c: Context) => {
      const body = await c.req.json().catch(() => null);
      if (!body) return c.json({ error: { type: "invalid_request", message: "invalid JSON body" } }, 400);
      applyModelAlias(body, cfg);
      // Checked against the resolved model: an alias pointing at a dead model is
      // just as unusable as naming it directly. Models we have no verdict on pass
      // through — the request itself is how we find out.
      const known = body.model ? deps.modelStatus.get(body.model) : undefined;
      if (known?.state === "unavailable")
        return c.json(
          {
            error: {
              type: "model_unavailable",
              message: `model ${body.model} is not currently served by the relay (last upstream status ${known.lastStatus})`,
            },
          },
          400,
        );
      const started = Date.now();
      const result = await runDialect(spec, deps, body, !!body.stream, c.req.header("anthropic-beta"));
      return finish(c, result, spec.kind, body.model ?? "", started);
    };
    for (const p of [spec.pathname, ...(spec.altPathnames ?? [])]) app.post(p, handler);
  };

  route(messagesDialect);
  route(chatDialect);
  route(responsesDialect);

  app.get("/v1/models", async (c) => {
    const { response } = await deps.pool.execute({ kind: "chat", pathname: "/v1/models", method: "GET" });
    const body: any = await response.json().catch(() => ({}));
    if (Array.isArray(body?.data)) {
      // The catalog is also how we discover models worth probing later.
      deps.modelStatus.seed(body.data.map((m: any) => m?.id).filter((id: unknown): id is string => !!id));
      body.data = body.data.filter((m: any) => deps.modelStatus.get(m?.id)?.state !== "unavailable");
    }
    return c.json(body, response.status as any);
  });

  app.get("/health", (c) => {
    const accts = deps.store.list();
    const now = Date.now();
    return c.json({
      ok: true,
      relay: cfg.relayBase,
      provider: cfg.searchProvider,
      signing: cfg.deviceSigning,
      auth: deps.keys.count() > 0,
      accounts: accts.length,
      enabled: accts.filter((a) => a.disabledUntil <= now).length,
    });
  });

  // Public, unauthenticated, and cached: see usage-page.ts for why the TTL is the
  // thing that makes it safe to expose. Totals only — no account is named here.
  const usage = createUsageSource(
    deps.pool,
    () => deps.store.list().map((a) => a.id),
    (sinceMs, bucket) => deps.usage.dailyTokens(sinceMs, cfg.usageTzOffsetHours, bucket),
    (sinceMs) => deps.usage.modelTokens(sinceMs),
    (sinceMs, bucket) => deps.usage.dailyStats(sinceMs, cfg.usageTzOffsetHours, bucket),
  );

  // Immutable: the filename is only ever bumped by a dependency upgrade, and the
  // point of self-hosting is that a repeat visitor pays for it once.
  app.get(
    "/usage/chart.js",
    () =>
      new Response(chartAsset(), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
  );

  app.get("/usage", async (c) => {
    const snap = await usage.get();
    // The API: `?format=json&range=24h|7d|30d` returns the account state plus one
    // range's windowed numbers, flattened. The page pre-renders all three and
    // switches client-side, so it needs the whole snapshot instead.
    if (/application\/json/.test(c.req.header("accept") ?? "") || /[?&]format=json/.test(c.req.url)) {
      const range = parseRange(c.req.query("range"));
      const { windows, serving, total, takenAt } = snap;
      return c.json({ windows, serving, total, takenAt, range, ...snap.byRange[range] });
    }
    return c.html(renderUsagePage(snap, Date.now(), cfg.usageTzOffsetHours), 200, {
      // A minute-old number is fine to reuse; a stale one for longer is not.
      "cache-control": "public, max-age=30",
    });
  });

  app.get("/metrics", async (c) => {
    const wantProm = /format=prometheus/.test(c.req.url) || /text\/plain/.test(c.req.header("accept") ?? "");
    if (wantProm)
      return new Response(await deps.metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } });
    return c.json(await deps.metrics.json());
  });

  return app;
}
