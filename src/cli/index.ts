import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
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
    case "accounts":
      if (_[1] === "import") return cmdAccountsImport(cfg, flags);
      if (_[1] === "add") return cmdAccountsAdd(cfg, flags);
      if (_[1] === "list") return cmdAccountsList(cfg);
      if (_[1] === "remove") return cmdAccountsRemove(cfg, _[2]!);
      if (_[1] === "exercise") return cmdAccountsExercise(cfg, flags);
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
    "usage: mirasim-gateway <serve|migrate|accounts (import|add|list|remove|exercise)|keys (mint|list|revoke)|device (from-app|show)|models (status|probe)>",
  );
  process.exit(1);
}
