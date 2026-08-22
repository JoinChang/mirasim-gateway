import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";
import { classifyOutcome } from "../../src/models/classify.js";
import { createProber } from "../../src/models/prober.js";
import { recordOutcome } from "../../src/models/record.js";
import { fakePool, R } from "../helpers/fakePool.js";

function setup(fileJson: Record<string, unknown> = {}, behaviour?: (model: string) => Response) {
  const repo = modelStatusRepo(memDb());
  const { pool, requests } = fakePool({
    respond: (req) => (behaviour ? behaviour(req.model ?? "") : R({ ok: 1 })),
    accountId: "a1",
  });
  const cfg = loadConfig({ fileJson: { modelProbeTtlMs: 10_000, ...fileJson }, env: {} });
  return { prober: createProber({ pool, repo, cfg }), repo, requests };
}

describe("createProber.runOnce", () => {
  it("probes models it has no verdict on", async () => {
    const { prober, repo, requests } = setup();
    repo.seed(["claude-opus-5", "gpt-5.6-sol"]);
    await prober.runOnce();
    expect(requests.map((r) => r.model).sort()).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
  });

  it("probes exactly the models it is handed, bypassing the staleness cycle", async () => {
    const { prober, repo, requests } = setup();
    repo.markOk("claude-opus-5", Date.now(), null); // fresh — the cycle would skip it
    repo.markOk("gpt-5.6-sol", Date.now(), null);
    await prober.runOnce(["claude-opus-5"]);
    expect(requests.map((r) => r.model)).toEqual(["claude-opus-5"]);
  });

  it("spends nothing when every verdict is still fresh", async () => {
    const { prober, repo, requests } = setup();
    repo.markOk("claude-opus-5", Date.now(), null);
    await prober.runOnce();
    expect(requests.map((r) => r.model)).toEqual([]);
  });

  it("stays within the per-cycle budget", async () => {
    const { prober, repo, requests } = setup({ modelProbeMaxPerCycle: 2 });
    repo.seed(["a", "b", "c", "d", "e"]);
    await prober.runOnce();
    expect(requests.map((r) => r.model)).toHaveLength(2);
  });

  it("reports which models it probed", async () => {
    const { prober, repo } = setup();
    repo.seed(["only-one"]);
    expect(await prober.runOnce()).toEqual(["only-one"]);
  });

  // The relay answers max_tokens:1 with 400 invalid_request_error, which says
  // nothing about the model — so such a probe silently leaves it unknown forever.
  it("asks for enough output tokens that the relay treats the probe as a real request", async () => {
    const { prober, repo, requests } = setup();
    repo.seed(["gpt-5.6-sol"]);
    await prober.runOnce();
    expect((requests[0]!.body as any).max_tokens).toBeGreaterThanOrEqual(16);
  });

  it("flags a probe that produced no verdict instead of leaving it silently unknown", async () => {
    const repo = modelStatusRepo(memDb());
    const logs: string[] = [];
    // Mirrors the real wiring: the pool classifies and records the outcome.
    const { pool } = fakePool({
      accountId: "a1",
      respond: (req) => {
        const status = req.model === "mystery" ? 400 : 200;
        const response = R({ ok: 1 }, status);
        recordOutcome(
          repo,
          req.model!,
          classifyOutcome(status, (k) => response.headers.get(k)),
          Date.now(),
        );
        return response;
      },
    });
    const cfg = loadConfig({ fileJson: { modelProbeTtlMs: 10_000 }, env: {} });
    const prober = createProber({ pool, repo, cfg, log: (m) => logs.push(m) });
    repo.seed(["mystery", "normal"]);
    await prober.runOnce();
    expect(logs.join("\n")).toMatch(/no verdict.*mystery/);
  });

  it("keeps going when one probe blows up", async () => {
    const { prober, repo, requests } = setup({}, (m) => {
      if (m === "boom") throw new Error("upstream exploded");
      return R({ ok: 1 });
    });
    repo.seed(["boom", "fine"]);
    await prober.runOnce();
    expect(requests.map((r) => r.model).sort()).toEqual(["boom", "fine"]);
  });
});
