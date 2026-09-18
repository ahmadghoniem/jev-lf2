# Jev integration

Source of truth is the live docs — [index](https://docs.typesafe.ai/llms.txt),
[HTTP API](https://docs.typesafe.ai/api.md). The agent skill
(`typesafe@typesafe-ai`, v0.5.7) is installed and says to read those before
writing integration code.

## Contract

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json

{ "model": "jev-latest", "state": <string|object|array>, "questions": { ... } }
```

Question shapes:

- every type needs `type` and `instructions`
- `noul` — optional `criteria` with `true` / `false` descriptions; returns `noul` (0–1)
- `choice` — required `criteria` map of option → description; returns `choice`,
  `probabilities`, `confidence`
- `score` — required `criteria` array, 2+ ordered level descriptions; returns
  `score`, `legend`, `probabilities`, `confidence`

Response carries `model`, `answers` keyed by question id, and
`usage.input_tokens` / `usage.output_tokens`.

## The client

`src/jev/client.mjs` is derived from `@typesafe-ai/sdk` 0.6.0 rather than
depending on it.

Kept, because it is tedious to get right and identical everywhere: the error
taxonomy, turning a 422 body into a readable message, `Retry-After` parsing, the
`x-typesafe-request-id` header, and the `noul` / `choice` / `score` builders with
their validation.

Replaced: the retry policy. The SDK retries 408/429/5xx with backoff, which is
right for a batch job and wrong inside a game tick — a retry that lands 500 ms
late answers a question about a fight that has already moved on. So:

- `ask()` — one attempt, hard deadline, returns `null` on a miss or a service
  failure so the caller can keep playing. A 401 or a malformed question set
  still throws, because those are bugs, not weather.
- `replay()` — the offline path over recorded states, where retries and
  `Retry-After` belong.

It also accumulates `usage` across a run, which is what the budget line in the
manifest comes from.

## Measured behaviour

First live calls, 2026-09-19, from this machine:

| | |
|---|---|
| model returned | `jev-1.13.0` |
| round trip, cold | 723–839 ms |
| round trip, warm connection | **328 ms** |
| `input_tokens` for a small state + 2 questions | 574 |
| `output_tokens` | 65 |

At 574 input tokens and $42 per billion, a call costs about **0.0024 cents**. A
three-minute match at 2 Hz is roughly **360 calls ≈ 0.9 cents**, so the $5
credit covers several hundred matches. The harness logs `usage` on every call so
the real figure replaces this one.

The latency is the design constraint: **the Jev layer runs at about 2 Hz**, and
everything time-critical has to be local.

A first sanity check of the judgement itself, on a hand-written state — Henry at
full health, enemy far, a knife one dash away:

```
action: grab_item   confidence 0.75   { grab_item 0.81, advance 0.15, shoot 0.02, retreat 0.01 }
commit: 0.26
```

Sensible on both counts, and stable across repeats.

## Known issues in Jev 1.13 that hit this project

| Issue | Consequence here |
|---|---|
| Unreliable math and counting | never send counts to be compared; code counts |
| Poor with raw numeric representations and comparisons | coordinates and HP go as named buckets |
| Score interpolation unreliable | use scores for threshold crossing only, never magnitude |
| Large irrelevant state distracts | send 2–3 threats, not the whole arena |
| Literal reading | criteria must spell out boundary cases |
| Adversarial/injected content | not a risk here; state is machine-generated |
| Spatial reasoning | **not mentioned either way** — untested, and this is a spatial game |

That last row is the project's main research risk. Phase 1 is partly a test of it.

Guidance that shapes the request, from the skill and docs:

- ask independent questions in one request; they run in parallel
- question **ids are not sent to the model** — the meaning must be complete
  inside `instructions` and `criteria`
- reference nested state with backticked paths, e.g. `` `threats[0].doing` ``
- score levels must describe concrete situations and stand alone
- include a no-match option wherever nothing may fit
- confidence summarises distribution concentration, not correctness; a noul near
  0.5 means genuinely uncertain, not "medium intensity"
- complementary probabilities do not necessarily sum to 1

## Deferred: Cloudflare Workers AI

`typesafe/jev` is also served through Workers AI. The Cloudflare edge is 43 ms
from this machine versus roughly 200 ms of network to `api.typesafe.ai`, so a
Worker of our own doing the call edge-side could cut the round trip. The
control-plane REST endpoint measured 245–400 ms and does not help.

Not now. Direct API first; revisit once the harness works and latency is the
binding constraint.
