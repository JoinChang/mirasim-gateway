export interface RoundEvent {
  accountId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: number;
  latencyMs: number;
}

export interface AccountTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
  avgLatencyMs: number;
}

export interface RoundSummary {
  perAccount: Record<string, AccountTotals>;
  totalTokens: number;
  /** Accounts that this round never reached — the pool never picked them. */
  untouched: string[];
}

/** Fold a round's usage rows into per-account totals so cost and coverage are visible. */
export function summarizeRound(events: RoundEvent[], allAccounts: string[] = []): RoundSummary {
  const perAccount: Record<string, AccountTotals> = {};
  const latencies: Record<string, number[]> = {};

  for (const e of events) {
    const id = e.accountId ?? "<none>";
    perAccount[id] ??= { requests: 0, inputTokens: 0, outputTokens: 0, failures: 0, avgLatencyMs: 0 };
    const t = perAccount[id]!;
    t.requests++;
    t.inputTokens += e.inputTokens;
    t.outputTokens += e.outputTokens;
    if (e.status < 200 || e.status >= 300) t.failures++;
    latencies[id] ??= [];
    latencies[id]!.push(e.latencyMs);
  }
  for (const [id, xs] of Object.entries(latencies))
    perAccount[id]!.avgLatencyMs = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

  return {
    perAccount,
    totalTokens: events.reduce((n, e) => n + e.inputTokens + e.outputTokens, 0),
    untouched: allAccounts.filter((id) => !perAccount[id]),
  };
}
