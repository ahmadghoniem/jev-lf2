# Jev integration notes

Source of truth is the live docs — [index](https://docs.typesafe.ai/llms.txt),
[HTTP API](https://docs.typesafe.ai/api.md). The agent skill (`typesafe@typesafe-ai`,
v0.5.7) is installed in this environment and says to read those pages before writing
integration code. What follows is what matters for a real-time loop.

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
- `score` — required `criteria` array, 2+ ordered level descriptions; returns `score`,
  `legend`, `probabilities`, `confidence`

Response: `model`, `answers` keyed by question id, `usage.input_tokens` /
`usage.output_tokens`.

Errors: `401` bad key, `422` validation, `429` rate limited, `529` overloaded. Back off
exponentially — but in this harness a failed call must **not** stall the tick; skip the
judgement and run on reflexes.

SDKs exist (`npm install @typesafe-ai/sdk`, `pip install typesafe-sdk`, both read
`TYPESAFE_API_KEY`). A hand-rolled `fetch` with a keep-alive agent is likely better here,
because the loop needs a hard per-tick deadline and connection reuse more than it needs
retry policy.

## Guidance that shapes our design

From the skill and docs:

- **Ask independent questions in one request.** They run in parallel and add little
  latency. Serial requests are only for genuine dependencies.
- Question **ids are not sent to the model** — the meaning must be complete inside
  `instructions` and `criteria`.
- Reference nested state with backticked paths, e.g. `` `threats[0].doing` ``.
- Score levels must describe **concrete situations** and stand alone.
- Include a **no-match** option wherever nothing may fit.
- Confidence summarises distribution concentration, not correctness. A noul near 0.5 means
  genuinely uncertain, not "medium intensity".
- Don't assume complementary probabilities sum to 1.

## Known issues in Jev 1.13 that hit this project directly

| Issue | Consequence here |
|---|---|
| Unreliable math and counting | never send counts to be compared; code counts |
| Poor with raw numeric representations and comparisons | coordinates and HP go as named buckets |
| Score interpolation unreliable | use scores for threshold crossing only, never magnitude |
| Large irrelevant state distracts | send 2–3 threats, not the whole arena |
| Literal reading | criteria must spell out boundary cases |
| Adversarial/injected content | not a risk here; state is machine-generated |
| Spatial reasoning | **not mentioned either way** — untested, and this is a spatial game |

That last row is the main research risk of the project. Phase 1 is partly a test of it.

## Budget

Published price: **$42 per billion input tokens, output free**. A ~600-token state at 3 Hz
for a 3-minute match ≈ **1.4 cents**, so a $5 credit is hundreds of matches.

This does not reconcile with the ~$7/hour quoted for the Doom demo at ~10 decisions/sec,
which implies a far larger state per call. **Resolve it on the first real call** by reading
`usage.input_tokens` and computing the true burn rate before running long sessions. The
harness logs `usage` on every tick for exactly this reason.

## Measured latency from this machine (2026-09-18)

TCP connect 199–205 ms, warm POST 201–212 ms on the auth-error path. Budget **~200 ms of
network per call** before inference. See [00-findings.md](00-findings.md).

Re-measure with a valid key, because the auth-error path may skip work that a real request
performs.

## Deferred: Cloudflare Workers AI

`typesafe/jev` is also served through Workers AI. The Cloudflare edge is 43 ms from this
machine versus 200 ms to `api.typesafe.ai`, so a thin Worker could be meaningfully faster —
but the control-plane REST endpoint measured 245–400 ms, so it only wins with a Worker of
our own doing the call edge-side. **Not now.** Direct API first, revisit once the harness
works and the latency budget is the bottleneck.
