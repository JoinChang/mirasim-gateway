import type { AccountsRepo } from "../db/repositories/accounts.js";
import type { KeysRepo } from "../db/repositories/keys.js";
import type { UsageRepo } from "../db/repositories/usage.js";
import type { Metrics } from "../metrics/registry.js";

export interface UsageInput {
  downstreamKeyId: string | null;
  accountId: string | null;
  dialect: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  webSearchRequests: number;
  status: number;
  viaRelay: boolean;
  cost: number | null;
  latencyMs: number;
}

export function createRecorder(deps: { usage: UsageRepo; keys: KeysRepo; accounts: AccountsRepo; metrics: Metrics }) {
  return {
    record(e: UsageInput): void {
      const now = Date.now();
      deps.usage.append({ ts: now, ...e, viaRelay: e.viaRelay ? 1 : 0 });
      const m = deps.metrics;
      m.requests.inc({ dialect: e.dialect, status: String(e.status) });
      if (e.inputTokens) m.tokens.inc({ dir: "in" }, e.inputTokens);
      if (e.outputTokens) m.tokens.inc({ dir: "out" }, e.outputTokens);
      if (e.webSearchRequests) m.searches.inc(e.webSearchRequests);
      if (e.status === 429) m.http429.inc();
      if (e.status >= 500) m.errors.inc();
      if (e.accountId) {
        m.perAccount.inc({ account: e.accountId });
        deps.accounts.setLastUsed(e.accountId, now);
      }
      if (e.downstreamKeyId) {
        m.perKey.inc({ key: e.downstreamKeyId });
        deps.keys.touch(e.downstreamKeyId, now);
      }
    },
  };
}
export type Recorder = ReturnType<typeof createRecorder>;
