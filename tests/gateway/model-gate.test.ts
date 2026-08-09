import { describe, expect, it } from "vitest";
import { accountStore } from "../../src/accounts/store.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { accountsRepo } from "../../src/db/repositories/accounts.js";
import { keysRepo } from "../../src/db/repositories/keys.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";
import { usageRepo } from "../../src/db/repositories/usage.js";
import { createApp } from "../../src/gateway/app.js";
import { createMetrics } from "../../src/metrics/registry.js";
import { createRecorder } from "../../src/usage/recorder.js";
import { fakePool, R } from "../helpers/fakePool.js";

function build(opts: { aliases?: Record<string, string>; script?: Array<() => Response> } = {}) {
  const db = memDb();
  const store = accountStore({ db, masterKey: null });
  store.add({ id: "a1", refreshToken: "r1" });
  const keys = keysRepo(db);
  const usage = usageRepo(db);
  const metrics = createMetrics();
  const recorder = createRecorder({ usage, keys, accounts: accountsRepo(db), metrics });
  const cfg = loadConfig({ fileJson: { deviceSigning: false, modelAliases: opts.aliases ?? {} }, env: {} });
  const modelStatus = modelStatusRepo(db);
  const script = opts.script ?? [() => R({ content: [{ type: "text", text: "hi" }] })];
  const { pool, requests } = fakePool({ script, accountId: "a1" });
  const search = async () => [];
  const app = createApp({ pool, store, cfg, keys, usage, metrics, recorder, search, modelStatus });
  return { app, modelStatus, poolCalls: () => requests.length };
}

const post = (app: any, body: unknown) =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("model availability gate", () => {
  it("refuses a model already known to be unusable, without spending a request", async () => {
    const { app, modelStatus, poolCalls } = build();
    modelStatus.markUnavailable("gpt-5.6-sol", Date.now(), 429);
    const res = await post(app, { model: "gpt-5.6-sol", messages: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("model_unavailable");
    expect(poolCalls()).toBe(0);
  });

  it("lets an unproven model through so its real outcome can be learned", async () => {
    const { app, poolCalls } = build();
    expect((await post(app, { model: "brand-new-model", messages: [] })).status).toBe(200);
    expect(poolCalls()).toBe(1);
  });

  it("lets a model known to work through", async () => {
    const { app, modelStatus } = build();
    modelStatus.markOk("claude-opus-5", Date.now(), null);
    expect((await post(app, { model: "claude-opus-5", messages: [] })).status).toBe(200);
  });

  it("judges the model the alias resolves to, not the alias the client typed", async () => {
    const { app, modelStatus } = build({ aliases: { "gpt-5-codex": "gpt-5.6" } });
    modelStatus.markUnavailable("gpt-5.6", Date.now(), 429);
    expect((await post(app, { model: "gpt-5-codex", messages: [] })).status).toBe(400);
  });
});

describe("/v1/models", () => {
  const catalog = () => R({ data: [{ id: "claude-opus-5" }, { id: "gpt-5.6-sol" }, { id: "never-seen" }] });

  it("hides models known to be unusable", async () => {
    const { app, modelStatus } = build({ script: [catalog] });
    modelStatus.markUnavailable("gpt-5.6-sol", Date.now(), 429);
    const ids = ((await (await app.request("/v1/models")).json()) as any).data.map((m: any) => m.id);
    expect(ids).toEqual(["claude-opus-5", "never-seen"]);
  });

  it("keeps models it has no verdict on", async () => {
    const { app } = build({ script: [catalog] });
    const ids = ((await (await app.request("/v1/models")).json()) as any).data.map((m: any) => m.id);
    expect(ids).toContain("never-seen");
  });
});
