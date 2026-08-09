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
keys mint --label L [--rpm N] [--daily-tokens N] | list | revoke <id>
device from-app | show                  macOS: import the app's registered device key (shared)
```

## Config (`config.json`, env overrides in CAPS)
search provider/limit, allow/prefer/block domains, model aliases, deviceSigning,
concurrency, cooldown/retry knobs. Secrets via env: `MIRASIM_MASTER_KEY`,
`FIRECRAWL_API_KEY`, `MIRASIM_APP_VERSION`, `MIRASIM_RELAY`, `MIRASIM_LOGIN`.

## Docker
```sh
cp .env.example .env   # set MIRASIM_MASTER_KEY, FIRECRAWL_API_KEY, downstream key via `keys mint`
docker compose up -d --build
```
Accounts/keys/db live in the `./data` volume (`gateway.db`); secrets are
AES-256-GCM encrypted at rest with `MIRASIM_MASTER_KEY`.

## Migrating from mirasim-ws-proxy
```sh
node dist/index.js accounts import --from ~/mirasim-ws-proxy/accounts.json
# carries over the encrypted accounts + device.pem (zero re-login)
```

## Note
Pooling / reselling relay credit likely violates Mirasim's ToS (ban risk). Keep
concurrency modest. An account must be used by the gateway **or** the desktop
app, not both (both rotate refresh tokens).
