# mirasim-gateway

Multi-tenant gateway that fronts the Mirasim relay with a pool of accounts and
exposes Anthropic- and OpenAI-compatible endpoints. TypeScript + Hono +
SQLite (Drizzle). Signs traffic like the desktop client (mrs-sig-v1 + device
ticket), emulates server-side `web_search`, and meters downstream callers per key.

## Endpoints
- `POST /v1/messages` (Anthropic) · `POST /v1/chat/completions` · `POST /v1/responses` (OpenAI, Codex) · `GET /v1/models`
- `GET /health` · `GET /metrics` (`?format=prometheus`)

## Quickstart (local)
```sh
pnpm install && pnpm build
export MIRASIM_MASTER_KEY=<64-hex>            # openssl rand -hex 32
export FIRECRAWL_API_KEY=fc-...               # web_search backend
export DATA_DIR=$PWD/data
node dist/index.js accounts add --token <mirasim refresh token>   # or `accounts import`
node dist/index.js keys mint --label default --rpm 120            # prints the downstream key once
node dist/index.js serve                                          # 127.0.0.1:8788
```
Point a client at it:
```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8788  ANTHROPIC_AUTH_TOKEN=<downstream key>  claude
```

## CLI
```
serve                                   start (auto-migrates)
migrate                                 apply DB migrations
accounts import [--from accounts.json]  migrate encrypted accounts + device.pem
accounts add [--token <rt>]             add one (validates via /auth/refresh)
accounts list | remove <id>
accounts check                          per account: is the relay serving again? (free)
keys mint --label L [--rpm N] [--daily-tokens N] | list | revoke <id>
device from-app | show                  macOS: import the app's registered device key (shared)
models status | probe                   per-model verdict; run one probe cycle now
accounts exercise [--models a,b] [--dry-run] [--gap ms]
                                        one real task per account, pinned round-robin
```

## Model availability
The relay advertises far more models than an account can use, and rejects the
unusable ones with a 429 that looks exactly like a quota throttle. The gateway
tells them apart by the quota headers: a real account throttle reports
near-exhausted utilization or sends `retry-after`, while a model-level rejection
arrives with the quota untouched. That distinction matters — treating one as the
other used to cool every account in the pool over a model that would never work,
taking the gateway down for healthy traffic too.

Verdicts come from real traffic for free, plus a prober that only checks models
whose verdict is missing or stale. They feed two things: requests for a known-dead
model are refused with `model_unavailable` (400) before an account is spent, and
`/v1/models` stops advertising them. Models with no verdict always pass through —
the request is how the gateway finds out. Probe bodies deliberately ask for real
output; `max_tokens: 1` is rejected as an invalid request, which would leave those
models unprobeable forever.

## Metering
Token counts feed the `--daily-tokens` quota, so both paths have to agree. Two
things made them undercount badly. Streamed responses were recorded as zero,
which exempted every streaming client — Claude Code always streams — so the body
is now metered as it passes through. And Anthropic reports `input_tokens` for the
uncached part only: measured on this relay, a 4804-token cached prompt reports
`input_tokens: 9`, and a real Claude Code turn reported 2 where the true figure
was 547508. Cache creation and cache reads are added in, while OpenAI's
`prompt_tokens` is taken as-is because it already counts them. The rule lives in
`src/usage/tokens.ts` so the streaming and JSON paths cannot drift apart.

## Keeping accounts exercised
`accounts exercise` runs one genuine task per account — reviewing this repo's own
code and git history — and writes the answers to `data/exercise-<ts>.md`. The work
is real rather than synthetic, so the output is worth reading (treat it as a
draft: models produce confident false positives).

Requests are **pinned per account** via `onlyAccount` rather than left to the
pool. Pool selection sorts by utilization, so the busiest accounts are chosen last
and a short round never reaches them — measured: 2 of 5 accounts went untouched
before pinning.

Cost is dominated by model choice, not prompt size. Two same-round requests of
~2.7k and ~3.1k tokens moved the 7d window by 0.017pp on `claude-haiku-4-5` versus
0.42pp on `claude-opus-4-8` — a 25× spread. Use `--models claude-haiku-4-5` for
keep-alive: a full 5-account round then costs about 0.02pp each.

Schedule it twice daily from the host — a systemd timer on a Linux server, launchd
on a mac — and have the schedule run `docker compose exec` rather than the host
CLI. That matters: `./data` is a bind mount, so a host process and the container
writing the same SQLite WAL across a virtualised filesystem is how databases get
corrupted. **The container is the
sole writer — always reach the CLI through it:**
```sh
docker compose exec -T gateway node dist/index.js models status
docker compose exec -T gateway node dist/index.js accounts list
```
The round degrades cleanly inside the container: the reviewed files ship in the
image, and with no `.git` there the commit digest is skipped rather than failing.

`accounts check` is the other half — it asks per account whether the relay is
serving again, over `GET /v1/models`, which costs no tokens and sits behind the
same shared-budget gate. Polling it while an outage lifts is therefore free; the
gradual restorations are announced a thousand users at a time, so the first
account back is the signal, not the last.

## Config (`config.json`, env overrides in CAPS)
search provider/limit, allow/prefer/block domains, model aliases, deviceSigning,
concurrency, cooldown/retry knobs. Model probing: `modelProbeEnabled` (default
on), `modelProbeIntervalMs` (15m), `modelProbeTtlMs` (6h — how long a verdict
stays fresh), `modelProbeMaxPerCycle` (8). Secrets via env: `MIRASIM_MASTER_KEY`,
`FIRECRAWL_API_KEY`, `MIRASIM_APP_VERSION`, `MIRASIM_RELAY`, `MIRASIM_LOGIN`.

## Docker
CI builds the image on every push to `main` and pushes it to
`ghcr.io/joinchang/mirasim-gateway` as `:latest` and `:<sha>`. Compose has no
`build:` stanza — the server pulls.
```sh
cp .env.example .env   # set MIRASIM_MASTER_KEY, FIRECRAWL_API_KEY
docker compose up -d   # pull_policy: always; serve applies migrations on startup
docker compose exec -T gateway node dist/index.js accounts add --token <rt>
docker compose exec -T gateway node dist/index.js keys mint --label default --rpm 120
```
Update with `docker compose pull && docker compose up -d`; pin a build by setting
`IMAGE_TAG` to a commit sha. Accounts/keys/db live in the `./data` volume
(`gateway.db`); secrets are AES-256-GCM encrypted at rest with
`MIRASIM_MASTER_KEY`.

## Migrating from mirasim-ws-proxy
```sh
node dist/index.js accounts import --from ~/mirasim-ws-proxy/accounts.json
# carries over the encrypted accounts + device.pem (zero re-login)
```

## Note
Pooling / reselling relay credit likely violates Mirasim's ToS (ban risk). Keep
concurrency modest. An account must be used by the gateway **or** the desktop
app, not both (both rotate refresh tokens).
