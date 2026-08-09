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

`all_accounts_throttled` is the fall-through of `pool.execute`, not a diagnosis:
it also fires on no accounts, deadline exceeded, a token refresh that threw, and a
call that threw. Check the model's verdict before believing it.

Keep-alive is scheduled by launchd calling `docker compose exec` — don't add a
host-side scheduler that opens the database directly.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo, which is
gitignored. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
