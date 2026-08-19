import { desc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountStore } from "../../src/accounts/store.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { accountsRepo } from "../../src/db/repositories/accounts.js";
import { keysRepo } from "../../src/db/repositories/keys.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";
import { usageRepo } from "../../src/db/repositories/usage.js";
import { usageEvents } from "../../src/db/schema.js";
import { createApp } from "../../src/gateway/app.js";
import { sha256Hex } from "../../src/gateway/util.js";
import { createMetrics } from "../../src/metrics/registry.js";
import { createRecorder } from "../../src/usage/recorder.js";
import { fakePool, R } from "../helpers/fakePool.js";

function build(opts: {
  script?: Array<() => Response>;
  keys?: Array<{ id: string; plain: string; rpm?: number }>;
  aliases?: Record<string, string>;
}) {
  const db = memDb();
  const store = accountStore({ db, masterKey: null });
  store.add({ id: "a1", refreshToken: "r1" });
  const keys = keysRepo(db);
  for (const k of opts.keys ?? [])
    keys.create({ id: k.id, keyHash: sha256Hex(k.plain), label: k.id, rpmLimit: k.rpm ?? null, dailyTokenLimit: null });
  const usage = usageRepo(db);
  const metrics = createMetrics();
  const recorder = createRecorder({ usage, keys, accounts: accountsRepo(db), metrics });
  const cfg = loadConfig({ fileJson: { deviceSigning: false, modelAliases: opts.aliases ?? {} }, env: {} });
  const script = opts.script ?? [
    () => R({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 2 } }),
  ];
  const { pool, requests } = fakePool({ script, accountId: "a1" });
  const search = async (q: string) => [{ url: `http://res/${q}`, title: "T", description: "D" }];
  const modelStatus = modelStatusRepo(db);
  return {
    app: createApp({ pool, store, cfg, keys, usage, metrics, recorder, search, modelStatus }),
    metrics,
    db,
    requests,
  };
}

/** Newest usage row, read through drizzle rather than reaching for the raw client. */
const latestUsage = (db: ReturnType<typeof memDb>) =>
  db.select().from(usageEvents).orderBy(desc(usageEvents.ts)).limit(1).all()[0]!;

const post = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("gateway app", () => {
  it("open mode (no keys) allows requests", async () => {
    const { app } = build({});
    const res = await post(app, "/v1/messages", { model: "c", messages: [] });
    expect(res.status).toBe(200);
    expect((await res.json()).content[0].text).toBe("hi");
  });

  it("enforces downstream auth when keys exist", async () => {
    const { app } = build({ keys: [{ id: "k1", plain: "sk-test" }] });
    expect((await post(app, "/v1/messages", { model: "c", messages: [] })).status).toBe(401);
    expect(
      (await post(app, "/v1/messages", { model: "c", messages: [] }, { authorization: "Bearer sk-test" })).status,
    ).toBe(200);
  });

  it("applies model alias before upstream", async () => {
    const { app, requests } = build({ aliases: { haiku: "claude-haiku-4-5" } });
    await post(app, "/v1/messages", { model: "haiku", messages: [] });
    expect((requests[0]!.body as any).model).toBe("claude-haiku-4-5");
  });

  it("/health reports accounts", async () => {
    const { app } = build({});
    const j = (await (await app.request("/health")).json()) as any;
    expect(j.ok).toBe(true);
    expect(j.accounts).toBe(1);
    expect(j.enabled).toBe(1);
  });

  it("/metrics prometheus after a request", async () => {
    const { app } = build({});
    await post(app, "/v1/messages", { model: "c", messages: [] });
    const txt = await (await app.request("/metrics?format=prometheus")).text();
    expect(txt).toContain("mira_requests_total");
  });

  it("rpm limit returns 429 on the second request", async () => {
    const { app } = build({
      keys: [{ id: "k1", plain: "sk", rpm: 1 }],
      script: [() => R({ ok: 1 }), () => R({ ok: 2 })],
    });
    const h = { authorization: "Bearer sk" };
    expect((await post(app, "/v1/messages", { model: "c", messages: [] }, h)).status).toBe(200);
    expect((await post(app, "/v1/messages", { model: "c", messages: [] }, h)).status).toBe(429);
  });

  it("meters a streamed response instead of recording it as zero", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n';
    const { app, db } = build({
      script: [() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })],
    });
    const res = await post(app, "/v1/messages", { model: "c", stream: true, messages: [] });
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
    const row = latestUsage(db);
    expect(row.inputTokens).toBe(11);
    expect(row.outputTokens).toBe(5);
  });

  it("passes the client's anthropic-beta down to the upstream call", async () => {
    const { app, requests } = build({});
    await post(
      app,
      "/v1/messages",
      { model: "c", messages: [] },
      { "anthropic-beta": "context-1m-2025-08-07,claude-code-20250219" },
    );
    expect(requests[0]?.betas).toBe("context-1m-2025-08-07,claude-code-20250219");
  });

  it("attributes a web_search request to an account and counts every hop", async () => {
    // The search loop makes two upstream calls. It used to record neither the
    // account nor the first hop's tokens.
    const { app, db } = build({
      script: [
        () =>
          R({
            content: [{ type: "tool_use", id: "t1", name: "web_search", input: { query: "x" } }],
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
        () => R({ content: [{ type: "text", text: "answer" }], usage: { input_tokens: 200, output_tokens: 20 } }),
      ],
    });
    const res = await post(app, "/v1/messages", {
      model: "c",
      messages: [{ role: "user", content: "q" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    expect(res.status).toBe(200);
    const row = latestUsage(db);
    expect(row.accountId).toBe("a1");
    expect(row.inputTokens).toBe(300);
    expect(row.outputTokens).toBe(30);
  });

  it("explains the relay's exhausted-capacity 403 instead of passing on an auth-looking error", async () => {
    const { app } = build({
      script: [
        () =>
          R({ type: "error", error: { type: "permission_error", message: "This request was not authorized." } }, 403),
      ],
    });
    const res = await post(app, "/v1/messages", { model: "c", messages: [] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/capacity is exhausted/);
    expect(body.error.message).toContain("This request was not authorized.");
    const txt = await (await app.request("/metrics?format=prometheus")).text();
    expect(txt).toMatch(/mira_relay_exhausted_total 1/);
  });
});
