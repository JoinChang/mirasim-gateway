import type { AppConfig } from "../config/index.js";
import { type DeviceIdentity, generateIdentity, identityFromPem } from "../crypto/device.js";
import {
  classifyOutcome,
  type Outcome,
  relayErrorMessage,
  relayErrorType,
  utilizationFrom,
} from "../models/classify.js";
import { callUpstream } from "../upstream/client.js";
import type { Kind } from "../upstream/relay.js";
import type { Semaphore } from "../upstream/sem.js";
import { type AttemptFailure, exhaustedResponse, type Stop } from "./exhausted.js";
import type { Refresher } from "./refresh.js";
import type { AccountStore, DecryptedAccount } from "./store.js";
import type { TicketManager } from "./ticket.js";

/**
 * What the relay said when it refused. The body is read (not cancelled) because
 * a discarded error body is exactly the evidence an outage needs, and error
 * bodies are small; `retry-after` rides along because it is what turned this
 * status into a throttle in the first place.
 */
async function said(
  resp: Response,
  gh: (k: string) => string | null,
  known: string | null,
): Promise<{ body?: string; retryAfter?: string }> {
  const retryAfter = gh("retry-after") ?? undefined;
  try {
    const t = (known ?? (await resp.text())).trim();
    return { ...(t ? { body: t.slice(0, 300) } : {}), ...(retryAfter ? { retryAfter } : {}) };
  } catch {
    return retryAfter ? { retryAfter } : {};
  }
}

/** Thrown values are not always Errors; the fall-through still has to print one. */
const errText = (e: unknown): string =>
  e instanceof Error
    ? typeof (e as any).status === "number"
      ? `${e.message} (HTTP ${(e as any).status})`
      : e.message
    : String(e);

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
    // Accounts this call has already found the relay unwilling to serve. Not a
    // cooldown — they are not at fault and must be free to work on the next
    // request — just "asked, and it said no", so the walk moves on instead of
    // picking the same one again.
    const refused = new Set<string>();
    const candidates = () =>
      (req.onlyAccount ? opts.store.list().filter((a) => a.id === req.onlyAccount) : opts.store.list()).filter(
        (a) => !refused.has(a.id),
      );
    let fiveXX = 0;
    /** The relay's own words, kept so an all-refused pool answers in them. */
    let refusal: { response: Response; accountId: string } | null = null;
    // What each attempt actually hit. Without this the fall-through can only
    // guess, and it guessed "throttled" for every one of them.
    const failures: AttemptFailure[] = [];
    let stop: Stop = "max_attempts";
    for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
      const sel = selectAccount(candidates(), Date.now());
      if (!sel) {
        stop = "no_accounts";
        break;
      }
      if (sel.waitMs > 0) {
        if (Date.now() + sel.waitMs > deadline) {
          stop = "deadline";
          break;
        }
        await sleep(sel.waitMs + 50);
      }
      const a = sel.account;
      opts.store.setLastUsed(a.id, Date.now());

      let token: string;
      try {
        token = await opts.refresher.ensureAccessToken(a);
      } catch (e) {
        failures.push({ accountId: a.id, stage: "refresh", error: errText(e) });
        coolBackoff(a);
        continue;
      }

      let ticket: string | null = null;
      let identity: DeviceIdentity | null = null;
      if (cfg.deviceSigning) {
        identity = deviceIdentityFor(a);
        ticket = await opts.ticketManager.ensure(a.id, token, identity);
      }
      // `ensure` returns null rather than throwing, so an unticketed request is
      // indistinguishable from a signed one unless the attempt records it.
      const ticketMissing = cfg.deviceSigning && !ticket ? { ticketMissing: true } : {};

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
      } catch (e) {
        failures.push({ accountId: a.id, stage: "call", error: errText(e), ...ticketMissing });
        coolBackoff(a);
        continue;
      }

      // A 429 cannot be judged from its headers alone — the relay answers with
      // it for a throttled account, for a model it has no deployment for, and
      // for its own shared budget running out, and only the body tells the third
      // apart. Read once here; the response is rebuilt so callers still get one.
      let text: string | null = null;
      if (resp.status === 429 || resp.status === 403) {
        text = await resp.text().catch(() => "");
        resp = new Response(text, { status: resp.status, headers: resp.headers });
      }

      const gh = (k: string) => resp.headers.get(k);
      const util = utilizationFrom(gh);
      if (util != null) opts.store.setUtilization(a.id, util);

      const outcome = classifyOutcome(resp.status, gh, {
        errorType: text ? relayErrorType(text) : undefined,
        errorMessage: text ? relayErrorMessage(text) : undefined,
      });
      if (req.model) opts.onOutcome?.(req.model, outcome);

      // The relay's shared budget, not this account's — so the account is never
      // cooled and never blamed for it.
      //
      // It used to end the call here too, on the reasoning that one pot means
      // failing over cannot help. Restoration proved that wrong: the operator
      // restores accounts a batch at a time, and on the first day of it one
      // account was served while four were still refused. Walking on costs a
      // round-trip; not walking on returns 429 while a working account sits
      // untried.
      if (outcome.kind === "relay_exhausted") {
        opts.store.setFails(a.id, 0);
        refused.add(a.id);
        refusal = { response: resp, accountId: a.id };
        failures.push({
          accountId: a.id,
          stage: "throttled",
          status: resp.status,
          ...ticketMissing,
          ...(await said(resp, gh, text)),
        });
        continue;
      }

      // A model the relay has no deployment for is not an account problem. Cooling
      // the pool for it would take every account offline over a model that will
      // never work, and walking the remaining accounts only repeats the rejection —
      // so hand the caller the relay's own error instead of burning the pool.
      if (outcome.kind === "model_unavailable" && resp.status === 429) {
        opts.store.setFails(a.id, 0);
        return { response: resp, accountId: a.id };
      }

      if (outcome.kind === "account_throttled") {
        // Read before discarding: the relay's own words are the only thing that
        // distinguishes a quota throttle from a refusal wearing a 429.
        failures.push({
          accountId: a.id,
          stage: "throttled",
          status: resp.status,
          ...ticketMissing,
          ...(await said(resp, gh, text)),
        });
        opts.store.setDisabledUntil(a.id, Date.now() + cooldownMsFrom(gh, a.consecutiveFails, cfg.cooldownMs));
        opts.store.setFails(a.id, a.consecutiveFails + 1);
        continue;
      }
      // An entitlement refusal belongs to the account and will not lift on a
      // retry, but it implicates neither the model nor the other accounts — a
      // pool holding more than one plan may well hold one that is entitled, and
      // handing this straight back would never find it. Take the account out of
      // rotation so the next request does not pay for it again, and keep the
      // relay's words in case none of them are entitled.
      if (outcome.kind === "account_refused") {
        refused.add(a.id);
        refusal = { response: resp, accountId: a.id };
        failures.push({
          accountId: a.id,
          stage: "refused",
          status: resp.status,
          ...ticketMissing,
          ...(await said(resp, gh, text)),
        });
        opts.store.setDisabledUntil(a.id, Date.now() + cooldownMsFrom(gh, a.consecutiveFails, cfg.cooldownMs));
        opts.store.setFails(a.id, a.consecutiveFails + 1);
        continue;
      }

      if (resp.status >= 500 && fiveXX < cfg.retry5xx) {
        failures.push({
          accountId: a.id,
          stage: "server_error",
          status: resp.status,
          ...ticketMissing,
          ...(await said(resp, gh, text)),
        });
        fiveXX++;
        await sleep(cfg.retry5xxDelayMs * fiveXX);
        continue;
      }
      opts.store.setFails(a.id, 0);
      return { response: resp, accountId: a.id };
    }
    // When every account was refused for the relay's own reasons, answer in the
    // relay's words rather than a summary of them: the message names the cause
    // and `explainRelayError` is keyed on it.
    if (refusal) return refusal;
    return { response: exhaustedResponse(failures, stop), accountId: "" };
  }

  return { execute, deviceIdentityFor };
}
