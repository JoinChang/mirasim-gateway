import type { Pool } from "../accounts/pool.js";
import type { AppConfig } from "../config/index.js";
import type { ModelStatusRepo } from "../db/repositories/modelStatus.js";
import { selectProbeTargets } from "./probe.js";

export interface Prober {
  /** Probe this cycle's targets. Returns the models actually probed. */
  runOnce(): Promise<string[]>;
  /** Begin the periodic loop. Returns a function that stops it. */
  start(): () => void;
}

export function createProber(opts: {
  pool: Pool;
  repo: ModelStatusRepo;
  cfg: AppConfig;
  now?: () => number;
  log?: (msg: string) => void;
}): Prober {
  const now = opts.now ?? (() => Date.now());

  async function probe(model: string): Promise<void> {
    // Deliberately the Anthropic path for every model: the relay routes on the
    // model group, so a model with no deployment is rejected the same way
    // whichever dialect asks for it. Verdicts land in the status table through
    // the pool's outcome hook — the same path real traffic uses.
    //
    // max_tokens has to be big enough to look like a real request: the relay
    // rejects max_tokens:1 with 400 invalid_request_error, which reveals nothing
    // about the model and would leave it unprobeable forever.
    const { response } = await opts.pool.execute({
      kind: "messages",
      pathname: "/v1/messages",
      body: { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      model,
    });
    await response.text().catch(() => "");
  }

  async function runOnce(): Promise<string[]> {
    const targets = selectProbeTargets(opts.repo.list(), now(), {
      ttlMs: opts.cfg.modelProbeTtlMs,
      max: opts.cfg.modelProbeMaxPerCycle,
    });
    const done: string[] = [];
    const inconclusive: string[] = [];
    for (const model of targets) {
      const before = opts.repo.get(model)?.lastCheckedAt ?? 0;
      try {
        await probe(model);
      } catch {
        // A probe that cannot even complete tells us nothing about the model,
        // and must not stop the rest of the cycle.
      }
      done.push(model);
      // No verdict means the relay rejected the probe rather than the model —
      // worth saying out loud, since the model would otherwise sit at "unknown"
      // forever while looking like it was being checked every cycle.
      if ((opts.repo.get(model)?.lastCheckedAt ?? 0) === before) inconclusive.push(model);
    }
    if (done.length) opts.log?.(`model probe: checked ${done.length} (${done.join(", ")})`);
    if (inconclusive.length)
      opts.log?.(`model probe: no verdict for ${inconclusive.join(", ")} — the relay rejected the probe itself`);
    return done;
  }

  function start(): () => void {
    const timer = setInterval(() => {
      runOnce().catch(() => {});
    }, opts.cfg.modelProbeIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { runOnce, start };
}
