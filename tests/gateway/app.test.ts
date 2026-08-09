import { describe, expect, it } from "vitest";
import type { Pool } from "../../src/accounts/pool.js";
import { accountStore } from "../../src/accounts/store.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { accountsRepo } from "../../src/db/repositories/accounts.js";
import { keysRepo } from "../../src/db/repositories/keys.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";
import { usageRepo } from "../../src/db/repositories/usage.js";
import { createApp } from "../../src/gateway/app.js";
import { sha256Hex } from "../../src/gateway/util.js";
import { createMetrics } from "../../src/metrics/registry.js";
import { createRecorder } from "../../src/usage/recorder.js";
import { R } from "../helpers/fakePool.js";

function build(opts: {
  script?: Array<() => Response>;
  keys?: Array<{ id: string; plain: string; rpm?: number }>;
  aliases?: Record<string, string>;
  bodies?: any[];
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
  const bodies = opts.bodies;
  const execOptions: any[] = [];
  const pool: Pool = {
    execute: async (_k, buildAndCall, _model, options) => {
      execOptions.push(options);
      const call = async (_p: string, b: unknown) => {
        if (bodies) bodies.push(b);
        const n = script.shift();
        return n ? n() : R({ ok: 1 });
      };
      return { response: await buildAndCall(call), accountId: "a1" };
    },
    deviceIdentityFor: () => ({}) as any,
  };
  const search = async (q: string) => [{ url: `http://res/${q}`, title: "T", description: "D" }];
  const modelStatus = modelStatusRepo(db);
  return {
    app: createApp({ pool, store, cfg, keys, usage, metrics, recorder, search, modelStatus }),
    metrics,
    db,
    execOptions,
  };
}

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
    const bodies: any[] = [];
    const { app } = build({ aliases: { haiku: "claude-haiku-4-5" }, bodies });
    await post(app, "/v1/messages", { model: "haiku", messages: [] });
    expect(bodies[0].model).toBe("claude-haiku-4-5");
  });

  it("/health reports accounts", async () => {
    const { app } = build({});
    const j = await (await app.request("/health")).json();
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
    const row: any = db.$client
      .prepare("select input_tokens, output_tokens from usage_events order by ts desc limit 1")
      .get();
    expect(row.input_tokens).toBe(11);
    expect(row.output_tokens).toBe(5);
  });

  it("passes the client's anthropic-beta down to the upstream call", async () => {
    const { app, execOptions } = build({});
    await post(
      app,
      "/v1/messages",
      { model: "c", messages: [] },
      { "anthropic-beta": "context-1m-2025-08-07,claude-code-20250219" },
    );
    expect(execOptions[0]?.betas).toBe("context-1m-2025-08-07,claude-code-20250219");
  });
});
