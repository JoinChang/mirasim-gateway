# Context

The project's glossary. It grows lazily: a term lands here when a piece of work
actually resolves what it means, not in advance. Use these words in issue titles,
test names and refactor proposals rather than drifting to synonyms.

## Dialect

One of the three wire formats the gateway speaks: `messages` (Anthropic),
`chat` (OpenAI chat completions), `responses` (OpenAI responses). A dialect is a
wire format, not a provider — all three are served by the same relay and the same
Claude models.

_Avoid_: "provider", "endpoint", "API version".

## Dialect spec

The description of everything that differs between dialects — its pathname, how
it spells a web-search request, how it caps searches, how it builds its
web-search adapter, and how it renders SSE. A spec is the adapter at
`runDialect`'s seam; the plumbing every dialect shares lives behind it.

Adding a fourth dialect means writing a spec, not a handler.

## Relay request

One call to the relay, described as data: `kind`, `pathname`, `body`, `method`,
`model`, `betas`, `onlyAccount`. Naming the `model` is what causes the outcome to
update that model's verdict; `onlyAccount` pins rather than hints.

## Model verdict

What the gateway currently believes about a model's usability — `ok`,
`unavailable`, or `unknown` — learned from real traffic and topped up by the
prober. A verdict is about the *model*, never about an account: an account
throttle leaves it untouched. `unknown` always passes through, because the
request is how the verdict gets formed.

_Avoid_: "model health", "model status" (the table is named `model_status`, but
the concept is the verdict).

## Relay transport

The one seam between the pool and the wire. Built once with the stable facts —
relay base, app version, whether device signing is on, the `fetch` to use, the
concurrency gate — and given a Relay request plus an account's credential, it
produces the actual signed HTTP request: the `x-mirasim-*` headers, the
collection opt-out, the body scrub, the beta filter, the signature. The pool
knows none of that; it hands over a Relay request and gets a `Response`. A fake
transport at the same seam is how the pool is tested without a live `fetch`.

_Avoid_: "http client", "fetch wrapper" — the point is the seam, not the call.

## Reaction

What the pool does about an outcome, as data: return the response to the caller
or walk on, and if walking on, whether to cool the account, whether to count the
failure against it, whether to drop it from this call's rotation. `reactTo` maps
a Model verdict to a Reaction; the pool applies it. The verdict is *what the
response means*; the reaction is *what to do about it* — kept apart so each is a
small, pure decision.
