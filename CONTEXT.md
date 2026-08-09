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
