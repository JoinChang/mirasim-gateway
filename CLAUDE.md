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

`config.json` is `COPY`d into the image, not mounted. A copy of it next to
`docker-compose.yml` on a host is therefore inert — it was mounted before the
image moved to GHCR, and a stale one left behind reads exactly like live config.
Change settings by shipping an image, or via the CAPS env overrides.

`dist/` is not in version control, and the container has its own copy. The image
is built by CI and pulled from GHCR; compose carries no `build:` stanza, so
`docker compose build` is a no-op. Source reaches a deployment by landing on
`main`, then `docker compose pull && docker compose up -d`. To run an unpushed
change, build the tag by hand:
`docker build -t ghcr.io/joinchang/mirasim-gateway:latest .`. A host
`pnpm build` alone leaves the container running the old code — and a stale `dist/`
is how `models status` came to print a usage string for commands that already
existed.

## Lint on Windows

`pnpm exec biome ci src tests` fails here on ~93 files, almost none of them yours.
`core.autocrlf=true` gives a CRLF working tree while biome formats to LF, so every
file differs; CI checks out LF on Linux and is green. The hazard is not the noise,
it is what hides in it — an import-order error and an over-long line both reached
a commit that way.

Check the files you changed against LF instead of reading past the wall:

```sh
mkdir -p .scratch/lintcheck/src/gateway
python -c "import io,sys; f=sys.argv[1]; io.open('.scratch/lintcheck/'+f,'wb').write(io.open(f,'rb').read().replace(b'
',b'
'))" src/gateway/app.ts
node node_modules/@biomejs/biome/bin/biome ci .scratch/lintcheck
```

Run it from the repo root so the root `biome.json` applies — a copy of the config
inside the scratch tree makes biome refuse both. `--line-ending=crlf` is the
tempting shortcut and it lies in the other direction: files holding multi-line
template literals (`usage-page.ts`, `chart-asset.ts`) then fail for nothing.

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
guessing. Read out of app 0.0.208's `server.cjs` (2026-08-19):

```
relay   https://relay.mirasim.ai      was mirasim-relay.mirofish.ai until 0.0.173
login   https://auth.mirasim.ai       was admin.test.mirofish.ai   until 0.0.150
CDN     cdn-assets.mirasim.ai         also answers on cdn-assets.mirofish.ai
```

The retirement is finished as far as the app is concerned: `mirofish.ai` appears
**zero** times in 0.0.208's server bundle, and both CDN names still serve
`latest.json`. The CDN host is not in that bundle at all — it belongs to the
shell's updater, so a payload cannot tell you what it is.

Each moved host still answers on both names for a while, so a migration is never
urgent — and never a fix. The old and new relay share **one** quota pool: during
the August outage both returned the same `credit_exhausted_shared`, with the same
accounts and the same device tickets. Switching hosts to escape a quota error is
wasted work.

Get the current constants from the release manifest, which needs no credentials:

```sh
curl -s https://cdn-assets.mirasim.ai/mirasim/releases/latest.json | jq '{version, payload}'
```

Hot updates cannot cross a shell ABI gap (`minShellAbi`/`maxShellAbi` in
`payload.json`), and the requirement climbs: 0.0.170 wanted 33, **0.0.208 wants
38** (min and max both). The installed shell on the mac is ABI 23, which is why
`~/.mirasim/app/` stops at 0.0.150 while the manifest races ahead — take the
current number from the manifest rather than from this line.

## Working against the live relay

Every failed upstream call cools an account (8s doubling, capped at `cooldownMs`),
so back-to-back probing poisons its own results: wait for `accounts list` to show
no cooldown between experiments. For isolated probing, run a second instance that
cannot disturb the pool:

```sh
MAX_ATTEMPTS=1 COOLDOWN_MS=1000 PORT=8799 MODEL_PROBE_ENABLED=0 node dist/index.js serve
```

`max_tokens: 1` no longer gets a probe rejected. It used to 400 with
`invalid_request_error`, which is why `prober.ts` asks for 16 — but measured
2026-08-19 on `claude-haiku-4-5` it answered **200**, one output token,
`stop_reason: max_tokens`. The 16 is now belt-and-braces rather than necessity,
and a 400 on a probe no longer has that explanation waiting for it. What still
rejects deterministically, and without spending a token, is a `max_tokens` past
the model's ceiling (999999) — the cheapest way to make the relay produce an
error on purpose.

`pool.execute`'s fall-through now names what it hit — per attempt, with the stage,
the status, `retry-after`, and the relay's own error body. Read `error.attempts`
before theorising; `all_accounts_throttled` is reserved for when throttling really
was all of it, and `pool_exhausted` / `no_accounts` cover the rest.

The relay does not frame its errors as SSE, even when the request asked to
stream. Measured 2026-08-19: an invalid request with `stream: true` came back
`400` / `content-type: application/json` and a bare `{"error":{…}}` body, byte
for byte the same as the non-streaming one. `relayError` in `classify.ts` reads a
`data:` frame as well, which the app also does — but that is insurance for a shape
this relay has not been seen to send, not a fix for observed behaviour. An error
raised *after* a stream has started is a separate case and still unobserved.

The relay ignores `anthropic-beta` outright. Measured 2026-08-19 on
`claude-haiku-4-5`: a real beta, a made-up one, and none at all all returned 200,
and the header was never echoed. So forwarding the caller's betas is harmless
(and free upside if the relay ever honours them), while a whitelist only discards
betas the caller legitimately asked for — `filterAnthropicBeta` now forwards all
but `oauth-2025-04-20`, the one value the desktop client itself strips. Two
sibling headers turned out to be inert too: `x-mirasim-probe` did not change the
5h utilization the response reported (identical delta with and without it), so the
gateway does not send it; `x-mirasim-collect: off` costs nothing and is sent on
every call regardless.

A 429 means three different things and only the body separates them: this account
is throttled, the relay has no deployment for the model, or **the relay's shared
budget is spent** (`credit_exhausted_shared`, also `shared_quota_unavailable`).
The last one sends `retry-after: 3600` and so read as an account throttle for four
days, cooling five healthy accounts sitting at 20% of their own quota. An account
is only blamed once its own utilization reaches 100% — the same bar the app uses.

That shared budget is **per plan, not per pool**. Measured 2026-08-19: the one
`max` account served normally at 10% of its 5h window while all four `plus`
accounts returned `credit_exhausted_shared` with their own windows untouched at
0%. So failing over is futile only among accounts on the same plan — across
plans it is the whole point of holding a mixed pool, and the pool should not
return a shared-budget refusal until it has tried the other plans it holds.

Keep-alive is scheduled by the host's scheduler calling `docker compose exec` —
a systemd timer on the server, launchd on a mac. Don't add a scheduler that opens
the database directly.

## Checking a constant against the app

The gateway impersonates the desktop client, so every constant it sends and every
relay error it interprets is a claim about that client — and the claim is
checkable. `payload.url` from the manifest above is the app's own server bundle,
needs no credentials, and carries the signing scheme, the quota header names and
the error vocabulary as plain string literals.

Two things to know before reading it. It is ~20 MB across six lines, one of them
15 MB, so search it by byte offset — line-oriented tools are useless on it. And
every number is spelled as hex arithmetic (`randomBytes(12)` ships as
`randomBytes(-0x5*0x4f5+0x1*-0x1f07+0x37dc)`), so evaluate rather than eyeball.

A signing constant found there can be copied: the client is the thing being
impersonated. A *classification* rule cannot — the bundle holds four separate
error vocabularies and only two reach the wire, so confirm against a real
response before teaching `classifyOutcome` a new branch. `blockedReason()`'s
returns are local UI state, and reading them as relay vocabulary would mark a
working model dead pool-wide.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo, which is
gitignored. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
