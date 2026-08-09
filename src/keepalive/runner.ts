import type { Pool } from "../accounts/pool.js";
import type { UsageRepo } from "../db/repositories/usage.js";
import type { RoundEvent } from "./summary.js";
import type { Task } from "./tasks.js";

export interface TaskOutput {
  label: string;
  model: string;
  accountId: string;
  status: number;
  text: string;
}

/**
 * Run one round of real work through the account pool.
 *
 * Requests go through `pool.execute`, which is the same path downstream traffic
 * takes — refresh, device ticket, signing, relay — so a round exercises the
 * accounts exactly as ordinary use would. `execute` hands back the account that
 * served each call, which is how coverage is measured without guessing.
 */
export async function runRound(opts: {
  pool: Pool;
  usage: UsageRepo;
  tasks: Task[];
  /** One request is issued per account, pinned to it. */
  accountIds: string[];
  gapMs?: number;
  now?: () => number;
  onResult?: (o: TaskOutput & { inputTokens: number; outputTokens: number; latencyMs: number }) => void;
}): Promise<{ events: RoundEvent[]; outputs: TaskOutput[] }> {
  const now = opts.now ?? (() => Date.now());
  const events: RoundEvent[] = [];
  const outputs: TaskOutput[] = [];
  if (!opts.tasks.length) return { events, outputs };

  // Driven by accounts, not tasks. Letting the pool pick would starve whichever
  // accounts happen to carry the highest utilization — exactly the ones a round
  // is supposed to reach.
  for (const [i, target] of opts.accountIds.entries()) {
    const task = opts.tasks[i % opts.tasks.length]!;
    const started = now();
    let status = 0;
    let accountId = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let text = "";

    try {
      const body = {
        model: task.model,
        max_tokens: task.maxTokens,
        messages: [{ role: "user", content: task.prompt }],
      };
      const res = await opts.pool.execute("messages", (call) => call("/v1/messages", body), task.model, {
        onlyAccount: target,
      });
      accountId = res.accountId;
      status = res.response.status;
      const json: any = await res.response.json().catch(() => null);
      inputTokens = json?.usage?.input_tokens ?? 0;
      outputTokens = json?.usage?.output_tokens ?? 0;
      text = (json?.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (!text && json?.error) text = `${json.error.type}: ${json.error.message}`;
    } catch (e) {
      text = `request failed: ${String(e)}`;
    }

    const latencyMs = now() - started;
    events.push({ accountId: accountId || null, model: task.model, inputTokens, outputTokens, status, latencyMs });
    const out: TaskOutput = { label: task.label, model: task.model, accountId, status, text };
    outputs.push(out);
    opts.usage.append({
      ts: started,
      downstreamKeyId: null,
      accountId: accountId || null,
      dialect: "keepalive",
      model: task.model,
      inputTokens,
      outputTokens,
      webSearchRequests: 0,
      cost: null,
      status,
      viaRelay: 1,
      latencyMs,
    } as any);
    opts.onResult?.({ ...out, inputTokens, outputTokens, latencyMs });

    if (opts.gapMs && i < opts.accountIds.length - 1) await new Promise((r) => setTimeout(r, opts.gapMs));
  }

  return { events, outputs };
}
