import type { AppConfig } from "../config/index.js";
import { type DeviceIdentity, generateIdentity, identityFromPem } from "../crypto/device.js";
import { classifyOutcome, type Outcome, utilizationFrom } from "../models/classify.js";
import { callUpstream } from "../upstream/client.js";
import type { Kind } from "../upstream/relay.js";
import type { Semaphore } from "../upstream/sem.js";
import type { Refresher } from "./refresh.js";
import type { AccountStore, DecryptedAccount } from "./store.js";
import type { TicketManager } from "./ticket.js";

export interface Selectable {
  id: string;
  disabledUntil: number;
  lastUtilization: number;
  lastUsedAt: number;
}

/** Enabled → least-utilized then LRU. All cooling → soonest-to-thaw + waitMs. */
export function selectAccount<T extends Selectable>(accounts: T[], now: number): { account: T; waitMs: number } | null {
  if (accounts.length === 0) return null;
  const enabled = accounts.filter((a) => (a.disabledUntil ?? 0) <= now);
  if (enabled.length) {
    enabled.sort((a, b) => a.lastUtilization - b.lastUtilization || a.lastUsedAt - b.lastUsedAt);
    return { account: enabled[0]!, waitMs: 0 };
  }
  const soon = [...accounts].sort((a, b) => (a.disabledUntil ?? 0) - (b.disabledUntil ?? 0))[0]!;
  return { account: soon, waitMs: Math.max(0, (soon.disabledUntil ?? 0) - now) };
}

export function cooldownMsFrom(
  getHeader: (k: string) => string | null | undefined,
  consecutiveFails: number,
  capMs: number,
  now = Date.now(),
): number {
  const ra = getHeader("retry-after");
  if (ra) {
    const s = /^\d+$/.test(ra.trim()) ? Number(ra) * 1000 : Date.parse(ra) - now;
    if (s > 0) return Math.min(s, capMs);
  }
  for (const h of ["anthropic-ratelimit-unified-5h-reset", "anthropic-ratelimit-unified-7d-reset"]) {
    const v = getHeader(h);
    if (v && /^\d+$/.test(v)) {
      const ms = Number(v) * 1000 - now;
      if (ms > 0 && ms < 10 * 60_000) return ms;
    }
  }
  const n = Math.max(1, consecutiveFails + 1);
  return Math.min(capMs, 8000 * 2 ** (n - 1));
}

/** One relay call, described as data. Everything a caller must decide, named. */
export interface RelayRequest {
  kind: Kind;
  pathname: string;
  body?: unknown;
  /** Defaults to POST. */
  method?: string;
  /**
   * The model being asked for, which is what the outcome updates a verdict
   * about. Omit for calls that name no model, such as fetching the catalogue.
   */
  model?: string;
  /** Client's anthropic-beta header, filtered to relay-honoured values upstream. */
  betas?: string;
  /**
   * Run on exactly this account and no other. Pooling normally balances by
   * utilization, which starves the busiest accounts — fine for serving traffic,
   * wrong when the caller's purpose is to reach a specific account.
   */
  onlyAccount?: string;
}

export interface Pool {
  execute(req: RelayRequest): Promise<{ response: Response; accountId: string }>;
  deviceIdentityFor(a: DecryptedAccount): DeviceIdentity;
}

export function createPool(opts: {
  store: AccountStore;
  refresher: Refresher;
  ticketManager: TicketManager;
  config: AppConfig;
  sem: Semaphore;
  fetchFn: typeof fetch;
  onOutcome?: (model: string, outcome: Outcome) => void;
}): Pool {
  const idCache = new Map<string, DeviceIdentity>();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function deviceIdentityFor(a: DecryptedAccount): DeviceIdentity {
    const shared = opts.store.getSharedDeviceKey();
    if (shared) {
      if (!idCache.has("__shared")) idCache.set("__shared", identityFromPem(shared));
      return idCache.get("__shared")!;
    }
    if (idCache.has(a.id)) return idCache.get(a.id)!;
    let pem = a.devicePrivateKey;
    if (!pem) {
      const gen = generateIdentity();
      pem = gen.pem;
      opts.store.setDeviceKey(a.id, pem);
    }
    const id = identityFromPem(pem);
    idCache.set(a.id, id);
    return id;
  }

  function coolBackoff(a: DecryptedAccount): void {
    opts.store.setDisabledUntil(
      a.id,
      Date.now() + Math.min(opts.config.cooldownMs, 8000 * 2 ** Math.max(0, a.consecutiveFails)),
    );
    opts.store.setFails(a.id, a.consecutiveFails + 1);
  }

  async function execute(req: RelayRequest): Promise<{ response: Response; accountId: string }> {
    const cfg = opts.config;
    const deadline = Date.now() + cfg.maxWaitMs;
    const candidates = () =>
      req.onlyAccount ? opts.store.list().filter((a) => a.id === req.onlyAccount) : opts.store.list();
    let fiveXX = 0;
    for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
      const sel = selectAccount(candidates(), Date.now());
      if (!sel) break;
      if (sel.waitMs > 0) {
        if (Date.now() + sel.waitMs > deadline) break;
        await sleep(sel.waitMs + 50);
      }
      const a = sel.account;
      opts.store.setLastUsed(a.id, Date.now());

      let token: string;
      try {
        token = await opts.refresher.ensureAccessToken(a);
      } catch {
        coolBackoff(a);
        continue;
      }

      let ticket: string | null = null;
      let identity: DeviceIdentity | null = null;
      if (cfg.deviceSigning) {
        identity = deviceIdentityFor(a);
        ticket = await opts.ticketManager.ensure(a.id, token, identity);
      }

      let resp: Response;
      try {
        resp = await callUpstream({ token, ticket, identity, sem: opts.sem }, req.pathname, req.body, req.kind, {
          deviceSigning: cfg.deviceSigning,
          appVersion: cfg.appVersion,
          relayBase: cfg.relayBase,
          fetchFn: opts.fetchFn,
          method: req.method,
          betas: req.betas,
        });
      } catch {
        coolBackoff(a);
        continue;
      }

      const gh = (k: string) => resp.headers.get(k);
      const util = utilizationFrom(gh);
      if (util != null) opts.store.setUtilization(a.id, util);

      const outcome = classifyOutcome(resp.status, gh);
      if (req.model) opts.onOutcome?.(req.model, outcome);

      // A model the relay has no deployment for is not an account problem. Cooling
      // the pool for it would take every account offline over a model that will
      // never work, and walking the remaining accounts only repeats the rejection —
      // so hand the caller the relay's own error instead of burning the pool.
      if (outcome.kind === "model_unavailable" && resp.status === 429) {
        opts.store.setFails(a.id, 0);
        return { response: resp, accountId: a.id };
      }

      if (outcome.kind === "account_throttled") {
        resp.body?.cancel?.().catch(() => {});
        opts.store.setDisabledUntil(a.id, Date.now() + cooldownMsFrom(gh, a.consecutiveFails, cfg.cooldownMs));
        opts.store.setFails(a.id, a.consecutiveFails + 1);
        continue;
      }
      if (resp.status >= 500 && fiveXX < cfg.retry5xx) {
        resp.body?.cancel?.().catch(() => {});
        fiveXX++;
        await sleep(cfg.retry5xxDelayMs * fiveXX);
        continue;
      }
      opts.store.setFails(a.id, 0);
      return { response: resp, accountId: a.id };
    }
    return {
      response: new Response(
        JSON.stringify({ error: { type: "all_accounts_throttled", message: "all accounts currently throttled" } }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      ),
      accountId: "",
    };
  }

  return { execute, deviceIdentityFor };
}
