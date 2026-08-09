import type { AppConfig } from "../config/index.js";
import type { Dialect, GatewayResult } from "../types/wire.js";
import { type DialectAdapter, runWebSearchLoop } from "../websearch/loop.js";
import type { DialectDeps } from "./deps.js";

/**
 * Everything that differs between the three wire dialects, and nothing else.
 *
 * The handlers used to be three modules whose implementations were identical
 * apart from these fields — so every cross-cutting fact (the model, the betas,
 * the serving account, the measured usage) had to be threaded through all three.
 * The dialects are now adapters at this seam; the plumbing lives once.
 */
export interface DialectSpec {
  kind: Dialect;
  pathname: string;
  /** Does this body ask for server-side web_search? Each dialect spells it differently. */
  wantsWebSearch(body: any): boolean;
  /** Anthropic carries a per-request cap on the tool itself; the OpenAI dialects do not. */
  maxUses(body: any): number;
  makeAdapter(body: any, cfg: AppConfig): DialectAdapter;
  /** Render a completed response as this dialect's SSE stream. */
  toSSE(json: any): string;
}

export async function runDialect(
  spec: DialectSpec,
  deps: DialectDeps,
  body: any,
  stream: boolean,
  betas?: string,
): Promise<GatewayResult> {
  if (!spec.wantsWebSearch(body)) {
    const { response, accountId } = await deps.pool.execute({
      kind: spec.kind,
      pathname: spec.pathname,
      body,
      model: body.model,
      betas,
    });
    if (stream && response.status === 200) return { type: "stream", response, accountId };
    return { type: "json", status: response.status, json: await response.json().catch(() => null), accountId };
  }

  const out = await runWebSearchLoop({
    adapter: spec.makeAdapter(body, deps.cfg),
    hop: async (b) => {
      const { response, accountId } = await deps.pool.execute({
        kind: spec.kind,
        pathname: spec.pathname,
        body: b,
        model: (b as any)?.model,
        betas,
      });
      return { status: response.status, json: await response.json().catch(() => null), accountId };
    },
    search: deps.search,
    maxUses: spec.maxUses(body),
  });

  const { accountId, usage } = out;
  if (out.status !== 200) return { type: "json", status: out.status, json: out.json, accountId, usage };
  return stream
    ? { type: "sse", text: spec.toSSE(out.json), json: out.json, accountId, usage }
    : { type: "json", status: 200, json: out.json, accountId, usage };
}
