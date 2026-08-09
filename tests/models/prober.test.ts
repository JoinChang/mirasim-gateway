import { describe, expect, it } from "vitest";
import type { Pool } from "../../src/accounts/pool.js";
import { loadConfig } from "../../src/config/index.js";
import { memDb } from "../../src/db/client.js";
import { modelStatusRepo } from "../../src/db/repositories/modelStatus.js";
import { classifyOutcome } from "../../src/models/classify.js";
import { createProber } from "../../src/models/prober.js";
import { recordOutcome } from "../../src/models/record.js";
import { R } from "../helpers/fakePool.js";

function setup(fileJson: Record<string, unknown> = {}, behaviour?: (model: string) => Response) {
  const repo = modelStatusRepo(memDb());
  const probed: string[] = [];
  const bodies: any[] = [];
  const pool: Pool = {
    execute: async (_kind, buildAndCall, model) => {
      probed.push(model ?? "<none>");
      const call = async (_p: string, b: unknown) => {
        bodies.push(b);
        return behaviour ? behaviour(model ?? "") : R({ ok: 1 });
      };
      return { response: await buildAndCall(call), accountId: "a1" };
    },
    deviceIdentityFor: () => ({}) as any,
  };
  const cfg = loadConfig({ fileJson: { modelProbeTtlMs: 10_000, ...fileJson }, env: {} });
  return { prober: createProber({ pool, repo, cfg }), repo, probed, bodies };
}

describe("createProber.runOnce", () => {
  it("probes models it has no verdict on", async () => {
    const { prober, repo, probed } = setup();
    repo.seed(["claude-opus-5", "gpt-5.6-sol"]);
    await prober.runOnce();
    expect(probed.sort()).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
  });

  it("spends nothing when every verdict is still fresh", async () => {
    const { prober, repo, probed } = setup();
    repo.markOk("claude-opus-5", Date.now(), null);
    await prober.runOnce();
    expect(probed).toEqual([]);
  });

  it("stays within the per-cycle budget", async () => {
    const { prober, repo, probed } = setup({ modelProbeMaxPerCycle: 2 });
    repo.seed(["a", "b", "c", "d", "e"]);
    await prober.runOnce();
    expect(probed).toHaveLength(2);
  });

  it("reports which models it probed", async () => {
    const { prober, repo } = setup();
    repo.seed(["only-one"]);
    expect(await prober.runOnce()).toEqual(["only-one"]);
  });

  // The relay answers max_tokens:1 with 400 invalid_request_error, which says
  // nothing about the model — so such a probe silently leaves it unknown forever.
  it("asks for enough output tokens that the relay treats the probe as a real request", async () => {
    const { prober, repo, bodies } = setup();
    repo.seed(["gpt-5.6-sol"]);
    await prober.runOnce();
    expect(bodies[0].max_tokens).toBeGreaterThanOrEqual(16);
  });

  it("flags a probe that produced no verdict instead of leaving it silently unknown", async () => {
    const repo = modelStatusRepo(memDb());
    const logs: string[] = [];
    // Mirrors the real wiring: the pool classifies and records the outcome.
    const pool: Pool = {
      execute: async (_kind, buildAndCall, model) => {
        const status = model === "mystery" ? 400 : 200;
        const call = async () => R({ ok: 1 }, status);
        const response = await buildAndCall(call);
        recordOutcome(
          repo,
          model!,
          classifyOutcome(status, (k) => response.headers.get(k)),
          Date.now(),
        );
        return { response, accountId: "a1" };
      },
      deviceIdentityFor: () => ({}) as any,
    };
    const cfg = loadConfig({ fileJson: { modelProbeTtlMs: 10_000 }, env: {} });
    const prober = createProber({ pool, repo, cfg, log: (m) => logs.push(m) });
    repo.seed(["mystery", "normal"]);
    await prober.runOnce();
    expect(logs.join("\n")).toMatch(/no verdict.*mystery/);
  });

  it("keeps going when one probe blows up", async () => {
    const { prober, repo, probed } = setup({}, (m) => {
      if (m === "boom") throw new Error("upstream exploded");
      return R({ ok: 1 });
    });
    repo.seed(["boom", "fine"]);
    await prober.runOnce();
    expect(probed.sort()).toEqual(["boom", "fine"]);
  });
});
