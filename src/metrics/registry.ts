import { Counter, Registry } from "prom-client";

export function createMetrics() {
  const registry = new Registry();
  const mk = (name: string, help: string, labelNames: string[] = []) =>
    new Counter({ name, help, labelNames, registers: [registry] });
  const requests = mk("mira_requests_total", "downstream requests", ["dialect", "status"]);
  const upstreamCalls = mk("mira_upstream_calls_total", "relay calls");
  const searches = mk("mira_searches_total", "web searches");
  const tokens = mk("mira_tokens_total", "tokens", ["dir"]);
  const http429 = mk("mira_http_429_total", "429 responses");
  const errors = mk("mira_errors_total", "errors");
  const perAccount = mk("mira_account_requests_total", "requests per account", ["account"]);
  const perKey = mk("mira_key_requests_total", "requests per downstream key", ["key"]);
  return {
    registry,
    requests,
    upstreamCalls,
    searches,
    tokens,
    http429,
    errors,
    perAccount,
    perKey,
    render: () => registry.metrics(),
    json: () => registry.getMetricsAsJSON(),
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
