import type { ModelStatusRepo } from "../db/repositories/modelStatus.js";
import type { Outcome } from "./classify.js";

/**
 * Persist what a response told us about the model — and only about the model.
 * An account throttle or a client error says nothing either way, so those leave
 * an existing verdict untouched rather than overwriting it with noise.
 */
export function recordOutcome(repo: ModelStatusRepo, model: string, outcome: Outcome, now: number): void {
  if (outcome.kind === "ok") repo.markOk(model, now, outcome.fallbackTo);
  else if (outcome.kind === "model_unavailable") repo.markUnavailable(model, now, outcome.status);
}
