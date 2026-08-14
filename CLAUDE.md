# mirasim-gateway

Multi-tenant gateway fronting the Mirasim relay with a pool of accounts. See
`README.md` for what it does; this file is the things that cause wrong work if you
don't know them.

## Running it

The gateway runs in Docker (`docker compose up -d`), and **the container is the
sole writer of `data/gateway.db`**. `./data` is a bind mount, so a host process
and the container writing one SQLite WAL across a virtualised filesystem is how
databases get corrupted. Always reach the CLI through the container:

```sh
docker compose exec -T gateway node dist/index.js models status
docker compose exec -T gateway node dist/index.js accounts list
```

`dist/` is not in version control, and the container has its own copy. After
changing source: `docker compose build && docker compose up -d`. A host
`pnpm build` alone leaves the container running the old code — and a stale `dist/`
is how `models status` came to print a usage string for commands that already
existed.

## Models

Only these eight work. The relay advertises ~40; the rest are dead:

```
claude-opus-5  claude-sonnet-5  claude-fable-5  claude-opus-4-8
claude-opus-4-7  claude-haiku-4-5  claude-haiku-4-5-20251001  claude-opus-5-20260724
```

`anthropic/*` returns 503 (no LiteLLM deployment) and `gpt-5.*` returns 429 (no
entitlement, at ~0.5% quota — it is an access signal, not a real throttle).
`anthropic/claude-opus-4-8` is the trap: it returns 200 but
`x-litellm-attempted-fallbacks: 1` shows LiteLLM served `claude-sonnet-5` instead.
Trust `models status` over the upstream catalogue.

The relay is LiteLLM in front of Bedrock, which batches several tokens per SSE
delta — streaming looks chunky and nothing in this repo can make it smoother.

## Metering

Token extraction lives only in `src/usage/tokens.ts`. Anthropic reports
`input_tokens` for the *uncached* part alone (a 4804-token cached prompt reports
9), while OpenAI's `prompt_tokens` already includes cached input. Three private
copies of this rule had drifted into undercounting real traffic by five orders of
magnitude — don't add a fourth.

## Hosts

`mirofish.ai` is being retired for `mirasim.ai`, one service at a time, and the
app is the only announcement — read the constants out of a payload rather than
guessing. As of app 0.0.182 (2026-08-13):

```
relay   https://relay.mirasim.ai      was mirasim-relay.mirofish.ai until 0.0.173
login   https://auth.mirasim.ai       was admin.test.mirofish.ai   until 0.0.150
CDN     cdn-assets.mirasim.ai         the manifest still lives on the old host
```

Each moved host still answers on both names for a while, so a migration is never
urgent — and never a fix. The old and new relay share **one** quota pool: during
the August outage both returned the same `credit_exhausted_shared`, with the same
accounts and the same device tickets. Switching hosts to escape a quota error is
wasted work.

Get the current constants from the release manifest, which needs no credentials:

```sh
curl -s https://cdn-assets.mirofish.ai/mirasim/releases/latest.json | jq '{version, payload}'
```

Hot updates cannot cross a shell ABI gap (`minShellAbi`/`maxShellAbi` in
`payload.json`) — the installed shell is ABI 23, and 0.0.170+ needs 33, which is
why `~/.mirasim/app/` stops at 0.0.150 while the manifest races ahead.

## Working against the live relay

Every failed upstream call cools an account (8s doubling, capped at `cooldownMs`),
so back-to-back probing poisons its own results: wait for `accounts list` to show
no cooldown between experiments. For isolated probing, run a second instance that
cannot disturb the pool:

```sh
MAX_ATTEMPTS=1 COOLDOWN_MS=1000 PORT=8799 MODEL_PROBE_ENABLED=0 node dist/index.js serve
```

Probe bodies need a plausible `max_tokens` — the relay rejects `max_tokens: 1`
with 400 `invalid_request_error`, which says nothing about the model and leaves it
unprobeable.

`pool.execute`'s fall-through now names what it hit — per attempt, with the stage,
the status, `retry-after`, and the relay's own error body. Read `error.attempts`
before theorising; `all_accounts_throttled` is reserved for when throttling really
was all of it, and `pool_exhausted` / `no_accounts` cover the rest.

A 429 means three different things and only the body separates them: this account
is throttled, the relay has no deployment for the model, or **the relay's shared
budget is spent** (`credit_exhausted_shared`, also `shared_quota_unavailable`).
The last one sends `retry-after: 3600` and so read as an account throttle for four
days, cooling five healthy accounts sitting at 20% of their own quota. Every
pooled account draws on that one budget, so failing over cannot help and the pool
returns it immediately. An account is only blamed once its own utilization reaches
100% — the same bar the app uses.

Keep-alive is scheduled by launchd calling `docker compose exec` — don't add a
host-side scheduler that opens the database directly.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo, which is
gitignored. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
