import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { summarize } from "../accounts/budget.js";
import { fetchLimits } from "../accounts/limits.js";
import { checkReachability } from "../accounts/reachability.js";
import { accountStore } from "../accounts/store.js";
import { type AppConfig, loadConfigFromDisk } from "../config/index.js";
import { identityFromPem } from "../crypto/device.js";
import { decodeJwt } from "../crypto/jwt.js";
import { open as unseal } from "../crypto/secretbox.js";
import { migrate, openDb } from "../db/client.js";
import { keysRepo } from "../db/repositories/keys.js";
import { sha256Hex } from "../gateway/util.js";
import { runRound } from "../keepalive/runner.js";
import { summarizeRound } from "../keepalive/summary.js";
import { buildTasks, gatherMaterial, nodeMaterialSource, selectModels } from "../keepalive/tasks.js";
import { buildRuntime } from "../runtime.js";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) flags[k!] = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else _.push(a);
  }
  return { _, flags };
}
const readStdin = (): string => {
  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
};
const log = (m: string) => process.stderr.write(`${m}\n`);

async function cmdServe(cfg: AppConfig) {
  const rt = buildRuntime(cfg);
  const accts = rt.store.list();
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && rt.keys.count() === 0)
    log("⚠️  bound to non-loopback host with NO downstream keys (open mode). Set PROXY keys before exposing.");
  if (cfg.modelProbeEnabled) rt.prober.start();
  serve({ fetch: rt.app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    log(
      `mirasim-gateway http://${cfg.host}:${info.port}  accounts=${accts.length} provider=${cfg.searchProvider} signing=${cfg.deviceSigning ? "on" : "off"} auth=${rt.keys.count() > 0 ? "on" : "off"} probe=${cfg.modelProbeEnabled ? `${Math.round(cfg.modelProbeIntervalMs / 1000)}s` : "off"}`,
    );
  });
}

async function cmdModelsStatus(cfg: AppConfig) {
  const rt = buildRuntime(cfg);
  const rows = rt.modelStatus.list();
  if (!rows.length) {
    log("no models recorded yet — run `models probe` or send a request");
    return;
  }
  const age = (ms: number) => (ms ? `${Math.round((Date.now() - ms) / 1000)}s ago` : "never");
  for (const r of rows)
    log(
      `${r.model.padEnd(38)}${r.state.padEnd(13)}${String(r.lastStatus || "-").padEnd(6)}${age(r.lastCheckedAt).padEnd(14)}${r.servedModel ? `→ served ${r.servedModel}` : ""}`,
    );
}

async function cmdAccountsExercise(cfg: AppConfig, flags: Record<string, string | boolean>) {
  const rt = buildRuntime(cfg);
  const rows = rt.modelStatus.list();
  const wanted =
    typeof flags.models === "string"
      ? String(flags.models)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
  const usable = selectModels(rows, wanted);
  if (!usable.length) {
    const available = selectModels(rows, null);
    log(
      wanted
        ? `none of the requested models are usable (have: ${available.join(", ") || "none"})`
        : "no model is usable — run `models probe` first",
    );
    process.exit(1);
  }

  // `--account` exists so a change that can cost credentials — a new login host,
  // a re-import — can be tried on one account before the other four follow.
  const all = rt.store.list().map((a) => a.id);
  const only = typeof flags.account === "string" ? String(flags.account) : null;
  const accountIds = only ? all.filter((id) => id === only || id.startsWith(only)) : all;
  if (only && !accountIds.length) {
    log(`no account matches ${only} (have: ${all.map((id) => id.slice(0, 16)).join(", ")})`);
    process.exit(1);
  }

  const tasks = buildTasks({ models: usable, ...gatherMaterial(nodeMaterialSource) });
  log(`exercising ${accountIds.length} accounts with ${tasks.length} real tasks over ${usable.length} models`);
  if (flags["dry-run"]) {
    for (const t of tasks) log(`  ${t.label.padEnd(34)} ${t.model.padEnd(20)} ~${t.prompt.length} chars in`);
    return;
  }

  const started = Date.now();
  const { events, outputs } = await runRound({
    pool: rt.pool,
    usage: rt.usage,
    tasks,
    accountIds,
    gapMs: flags.gap ? Number(flags.gap) : 3000,
    onResult: (r) =>
      log(
        `  ${r.label.padEnd(34)} ${String(r.status).padEnd(4)} ${(r.accountId || "-").slice(0, 16).padEnd(18)}${r.inputTokens}→${r.outputTokens} tok  ${r.latencyMs}ms`,
      ),
  });

  const summary = summarizeRound(events, accountIds);
  log("");
  log("account                             reqs  in      out     fails  avg latency");
  for (const [id, t] of Object.entries(summary.perAccount))
    log(
      `${id.padEnd(38)}${String(t.requests).padEnd(6)}${String(t.inputTokens).padEnd(8)}${String(t.outputTokens).padEnd(8)}${String(t.failures).padEnd(7)}${t.avgLatencyMs}ms`,
    );
  log(`\ntotal ${summary.totalTokens} tokens in ${Math.round((Date.now() - started) / 1000)}s`);
  if (summary.untouched.length) log(`⚠️  never exercised this round: ${summary.untouched.join(", ")}`);

  const outFile = path.join(cfg.dataDir, `exercise-${new Date(started).toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(
    outFile,
    outputs
      .map((o) => `## ${o.label}\n\n_${o.model} · ${o.accountId} · HTTP ${o.status}_\n\n${o.text}\n`)
      .join("\n---\n\n"),
  );
  log(`output written to ${outFile}`);
}

/**
 * Report, per account, whether the relay will serve it — and say so in the exit
 * code so a scheduler can watch without parsing anything: 0 once any account is
 * served, 1 while none is.
 */
async function cmdAccountsCheck(cfg: AppConfig) {
  const rt = buildRuntime(cfg);
  const rows = await checkReachability(
    rt.pool,
    rt.store.list().map((a) => a.id),
  );
  for (const r of rows)
    log(
      r.state === "ok"
        ? `${r.accountId}\tok\t${r.models} models`
        : r.state === "exhausted"
          ? `${r.accountId}\texhausted\tHTTP ${r.status}`
          : `${r.accountId}\terror\tHTTP ${r.status} ${r.detail}`,
    );
  const served = rows.filter((r) => r.state === "ok").length;
  log(`\n${served}/${rows.length} accounts served`);
  process.exit(served > 0 ? 0 : 1);
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function cmdAccountsLimits(cfg: AppConfig) {
  const rt = buildRuntime(cfg);
  const accounts = rt.store.list();
  const label = new Map(accounts.map((a) => [a.id, a.email ?? a.id]));
  const rows = await fetchLimits(
    rt.pool,
    accounts.map((a) => a.id),
  );

  let ok = 0;
  for (const r of rows) {
    if (r.state !== "ok") {
      log(`${label.get(r.accountId)}\terror\tHTTP ${r.status} ${r.detail}`);
      continue;
    }
    ok++;
    const marks = [r.suspended ? "suspended" : "", r.degraded ? "degraded" : "", r.unmetered ? "unmetered" : ""]
      .filter(Boolean)
      .join(",");
    log(`${label.get(r.accountId)}${marks ? `\t${marks}` : ""}`);
    for (const w of r.windows) {
      // A zero budget would divide by zero. The relay has not sent one, but the
      // percentage is the reason to read this at all, so guard over printing NaN.
      const pct = w.budgetCents > 0 ? `${((w.usedCents / w.budgetCents) * 100).toFixed(1)}%` : "?";
      const left = money(Math.max(0, w.budgetCents - w.usedCents));
      const reset = w.resetAt ? new Date(w.resetAt * 1000).toISOString().replace("T", " ").slice(0, 16) : "?";
      log(
        `  ${w.name.padEnd(4)} ${money(w.usedCents)} / ${money(w.budgetCents)}  ${pct} used  ${left} left  resets ${reset}`,
      );
    }
  }
  process.exit(ok > 0 ? 0 : 1);
}

const WINDOW_LABEL: Record<string, string> = {
  "5h": "Current session",
  "7d": "This week",
  "30d": "This month",
};

/** "3h 52m", "5d 23h" — two units is enough to plan around, more is noise. */
function until(epochSeconds: number, now = Date.now()): string {
  const ms = epochSeconds * 1000 - now;
  if (ms <= 0) return "any moment";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function bar(fraction: number, width = 24): string {
  const filled = Math.min(width, Math.max(0, Math.round(fraction * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function cmdUsage(cfg: AppConfig) {
  const rt = buildRuntime(cfg);
  const all = rt.store.list();

  // Ask who can serve before asking how much is left: an account the relay is
  // refusing has budget that cannot be spent, and adding it in would report
  // headroom nobody can use.
  const reach = await checkReachability(
    rt.pool,
    all.map((a) => a.id),
  );
  const serving = reach.filter((r) => r.state === "ok").map((r) => r.accountId);
  const refused = reach.length - serving.length;

  if (serving.length === 0) {
    log("no account is being served right now — nothing to total up");
    for (const r of reach) if (r.state !== "ok") log(`  ${r.accountId}\t${r.state}\tHTTP ${r.status}`);
    process.exit(1);
  }

  const windows = summarize(await fetchLimits(rt.pool, serving));
  const now = Date.now();

  log("");
  for (const w of windows) {
    const frac = w.budgetCents > 0 ? w.usedCents / w.budgetCents : 0;
    const label = WINDOW_LABEL[w.name] ?? w.name;
    log(`${label.padEnd(16)} ${bar(frac)}  ${(frac * 100).toFixed(1).padStart(5)}%`);
    log(
      `${" ".repeat(16)} $${(w.usedCents / 100).toFixed(2)} of $${(w.budgetCents / 100).toFixed(2)}` +
        `  ·  $${(Math.max(0, w.budgetCents - w.usedCents) / 100).toFixed(2)} left`,
    );
    if (w.resetAt) {
      const when = new Date(w.resetAt * 1000).toISOString().replace("T", " ").slice(0, 16);
      // Staggered windows reset one account at a time, so the first timestamp is
      // when *some* capacity returns, not all of it.
      log(`${" ".repeat(16)} resets in ${until(w.resetAt, now)} (${when})${w.staggered ? ", first of several" : ""}`);
    }
    log("");
  }

  log(
    `${serving.length} of ${all.length} accounts serving` +
      (refused > 0 ? ` · ${refused} refused by the relay and left out of the totals` : ""),
  );
  process.exit(0);
}

async function cmdModelsProbe(cfg: AppConfig) {
  const rt = buildRuntime(cfg);
  const done = await rt.prober.runOnce();
  log(done.length ? `probed ${done.length}: ${done.join(", ")}` : "nothing due for probing");
}

function storeFor(cfg: AppConfig) {
  const db = openDb(path.join(cfg.dataDir, "gateway.db"));
  migrate(db);
  return { db, store: accountStore({ db, masterKey: cfg.masterKey }), cfg };
}

async function cmdAccountsImport(cfg: AppConfig, flags: Record<string, string | boolean>) {
  const from = String(flags.from ?? path.join(os.homedir(), "mirasim-ws-proxy", "accounts.json"));
  const { store } = storeFor(cfg);
  const db = JSON.parse(fs.readFileSync(from, "utf8"));
  let n = 0;
  for (const a of db.accounts ?? []) {
    const refreshToken = unseal(a.refreshToken, cfg.masterKey);
    const devicePrivateKey = a.devicePrivateKey ? unseal(a.devicePrivateKey, cfg.masterKey) : null;
    store.add({ id: a.id, email: a.note ?? "", plan: "", refreshToken, devicePrivateKey });
    n++;
  }
  const devicePem = path.join(path.dirname(from), "device.pem");
  if (fs.existsSync(devicePem)) {
    store.setSharedDeviceKey(fs.readFileSync(devicePem, "utf8"));
    log(`imported shared device key from ${devicePem}`);
  }
  log(`imported ${n} accounts from ${from}`);
}

async function cmdAccountsAdd(cfg: AppConfig, flags: Record<string, string | boolean>) {
  const rt = (typeof flags.token === "string" ? flags.token : readStdin()).trim();
  if (!rt) {
    log("usage: accounts add --token <refresh> (or pipe via stdin)");
    process.exit(1);
  }
  const res = await fetch(`${cfg.loginBase}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!res.ok) {
    log(`validation failed HTTP ${res.status}`);
    process.exit(1);
  }
  const j: any = await res.json();
  const claims = decodeJwt(j.access_token) ?? {};
  const { store } = storeFor(cfg);
  store.add({
    id: claims.sub ?? `acct-${crypto.randomBytes(3).toString("hex")}`,
    email: claims.email ?? "",
    plan: claims.plan ?? "",
    refreshToken: j.refresh_token ?? rt,
  });
  log(`added ${claims.email ?? claims.sub} (plan=${claims.plan ?? "?"})`);
}

function cmdAccountsList(cfg: AppConfig) {
  const { store } = storeFor(cfg);
  const now = Date.now();
  for (const a of store.list())
    log(
      `${a.id}\t${a.email}\t${a.plan}\t${a.disabledUntil > now ? `cooldown ${Math.round((a.disabledUntil - now) / 1000)}s` : "enabled"}`,
    );
}
function cmdAccountsRemove(cfg: AppConfig, id: string) {
  const { store } = storeFor(cfg);
  store.remove(id);
  log(`removed ${id}`);
}

function cmdKeysMint(cfg: AppConfig, flags: Record<string, string | boolean>) {
  const { db } = storeFor(cfg);

  const key = `sk-mira-${crypto.randomBytes(24).toString("hex")}`;
  const id = `key_${crypto.randomBytes(4).toString("hex")}`;
  keysRepo(db).create({
    id,
    keyHash: sha256Hex(key),
    label: String(flags.label ?? "default"),
    rpmLimit: flags.rpm ? Number(flags.rpm) : null,
    dailyTokenLimit: flags["daily-tokens"] ? Number(flags["daily-tokens"]) : null,
  });
  log(`minted key id=${id} label=${flags.label ?? "default"}`);
  process.stdout.write(`${key}\n`);
  log("(store this now — it is not recoverable)");
}
function cmdKeysList(cfg: AppConfig) {
  const { db } = storeFor(cfg);
  for (const k of keysRepo(db).list())
    log(
      `${k.id}\t${k.label}\t${k.enabled ? "enabled" : "revoked"}\trpm=${k.rpmLimit ?? "-"}\tdaily=${k.dailyTokenLimit ?? "-"}`,
    );
}
function cmdKeysRevoke(cfg: AppConfig, id: string) {
  const { db } = storeFor(cfg);
  keysRepo(db).revoke(id);
  log(`revoked ${id}`);
}

function cmdDeviceFromApp(cfg: AppConfig) {
  const setting = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".mirasim", "setting.json"), "utf8"));
  if (!setting.device?.privateKey) {
    log("no device.privateKey in app");
    process.exit(1);
  }
  const kh = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "mirasim", "-a", "config-secret-key"],
    { encoding: "utf8" },
  ).trim();
  const pem = unseal(setting.device.privateKey, Buffer.from(kh, "hex"));
  const { store } = storeFor(cfg);
  store.setSharedDeviceKey(pem);
  log(`imported shared device key (deviceId ${identityFromPem(pem).deviceId})`);
}
function cmdDeviceShow(cfg: AppConfig) {
  const { store } = storeFor(cfg);
  const pem = store.getSharedDeviceKey();
  log(pem ? `shared deviceId ${identityFromPem(pem).deviceId}` : "per-account device identities (no shared key)");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {}
  const { _, flags } = parseArgs(argv);
  const cmd = _[0];
  const cfg = loadConfigFromDisk();
  switch (cmd) {
    case undefined:
    case "serve":
      return cmdServe(cfg);
    case "migrate": {
      storeFor(cfg);
      log("migrations applied");
      return;
    }
    case "usage":
      return cmdUsage(cfg);
    case "accounts":
      if (_[1] === "import") return cmdAccountsImport(cfg, flags);
      if (_[1] === "add") return cmdAccountsAdd(cfg, flags);
      if (_[1] === "list") return cmdAccountsList(cfg);
      if (_[1] === "remove") return cmdAccountsRemove(cfg, _[2]!);
      if (_[1] === "exercise") return cmdAccountsExercise(cfg, flags);
      if (_[1] === "check") return cmdAccountsCheck(cfg);
      if (_[1] === "limits") return cmdAccountsLimits(cfg);
      break;
    case "keys":
      if (_[1] === "mint") return cmdKeysMint(cfg, flags);
      if (_[1] === "list") return cmdKeysList(cfg);
      if (_[1] === "revoke") return cmdKeysRevoke(cfg, _[2]!);
      break;
    case "device":
      if (_[1] === "from-app") return cmdDeviceFromApp(cfg);
      if (_[1] === "show") return cmdDeviceShow(cfg);
      break;
    case "models":
      if (_[1] === "status") return cmdModelsStatus(cfg);
      if (_[1] === "probe") return cmdModelsProbe(cfg);
      break;
  }
  log(
    "usage: mirasim-gateway <serve|migrate|usage|accounts (import|add|list|remove|exercise|check|limits)|keys (mint|list|revoke)|device (from-app|show)|models (status|probe)>",
  );
  process.exit(1);
}
