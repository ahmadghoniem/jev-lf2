# What Jev users reported on X (Sep 15-25, 2026)

Gathered through Grok on 2026-09-25. "Measured" means the author gave a count, rate or latency; "opinion" means a lesson without numbers.

## 1. Question design

- **One subject per question.** A compound question ("Should this proceed without human approval?") sat near 0.50 on everything. Rewritten as one plain question ("Does this require a human to approve before it runs?"), the answers separated cleanly. Low confidence often means a muddy question, not a doubtful model. *(Ankit Kalluraya, opinion with examples)*
- **Options must not overlap, and labels need descriptions.** Overlapping options lower confidence. *(Taqi T, opinion)*
- **Explicit instructions beat vague ones.** One user claims 50-70% with loose prompts, near 100% once explicit. *(anecdote, no numbers)*
- **A yes/no score and a 2-option choice give different answers.** On 20 tickets, 7 pairs differed by more than 0.2 and 2 flipped across 0.5. A question and its negation summed to between 0.52 and 1.33. *(Jim Ma, measured, n=20)*
- **Few, well-built options beat a raw action space.** Tetris: when the harness precomputed good placements and Jev picked among them, it played well. With only left/right/rotate/drop it was "pretty much useless." *(Tony Dinh, ablation)*
- Two-option routing: 30/30, tied with GPT-5 nano and GPT-4.1 mini. *(Rouzbeh, measured, n=30)*
- **Shorter state:** nobody posted an accuracy A/B test. Latency stays flat as the prompt grows. *(Raihan Kabir, latency only)*

## 2. Structure

- **Many independent questions in one request is the normal pattern**, and extra questions don't seem to hurt the others. *(Michael Lee, ~5,000 requests, opinion on accuracy)*
- **Ask the branches up front (speculative fan-out).** Ask "which material?" together with "if stainless, which seal?" and "if brass, which seal?" in one call. Calls went from ~7 to ~3. Jev accuracy went from 47.0% to 55.6%, and median time from 4.60 s to 1.89 s. *(nikhil mudholkar, measured, 270 synthetic cases)*
- **Verification questions in the same call** ("does this still match the explicit constraints?") stopped 83 wrong answers and 6 correct ones (about 14:1). *(same study; verification tuned on the same cases)*
- **Latency is flat from 1 to 32 questions** (273 → 270 ms). *(Vincent Terrasi, measured)*
- A true two-stage design (a second call that depends on the first) is barely documented.

## 3. Confidence and thresholds

- **Accept when confident, escalate when unsure.** In a judge evaluation, a cascade at τ = 0.9 kept 99% of GPT-6's accuracy at 1/277th of the cost. Jev alone is close on routine and factual judging, weaker on hard correctness (78.6% vs 93.1%). *(JEV-as-a-Judge write-up, an evaluation rather than a live agent)*
- A 0.8 gate held 2 of 30 ambiguous messages for clarification. *(Rouzbeh, n=30)*
- **A 0.5 cut-off does not carry over between question shapes** (see Jim Ma above).
- **Choose the threshold on your own data.** 0.5 is only a convention, and keyword/TF-IDF sometimes matched Jev. *(Fawad H Syed, opinion)*
- **Keep an escape option** ("none / wait") when no choice fits, and treat ~0.5 as unresolved rather than a weak yes. *(recommended by several people, not A/B tested)*
- **Asking again and voting:** nobody reported it helping. Repeats came up only as a consistency problem.

## 4. Latency

- **Keeping the connection open:** median 0.32 s against 0.95 s when opening a new connection each time. *(Rouzbeh, measured)*
- Hosted figures: p50 ~150 ms and p95 ~350 ms over ~5,000 calls. Others report p50 369-384 ms and p95 443 ms, with the slowest at 1.3 s.
- **Throughput is not the same as one-shot latency.** On Snake, a local model won per call (6 ms vs 161 ms) because the game code pre-labelled the safe moves. Over 1,536 bulk decisions Jev was 4-11× faster and 100% right, against 82%. *(Kartikey Pandey, measured)*
- Batches of 300 and 801 questions in one call worked.
- No one posted response caching, warm-up experiments, or a deadline policy.

## 5. Real-time control

- **It works when the harness does the planning and Jev picks from a few labelled moves.** Tetris with proposed landing spots beat Haiku 4.5 and Gemini 3.8 Flash on speed; raw buttons failed.
- Vendor demos: a Doom decision took 0.114 s, but a scripted Doom bot still plays better. In blitz chess at one call per move it was losing by move 29. The framing is "reflexes, not strategy."
- Trading and robot posts are announcements without results; one trading bot's claims were disputed.
- **The pattern that keeps recurring:** usable with a small set of labelled moves plus a wait option; fails when Jev has to invent the plan.

## What this means for our harness

Our design already follows the main findings: the harness plans, Jev picks from described options, the option groups are asked in one request, and `wait` is always offered. Things worth trying, each to be measured over several games:

1. **Clearer questions.** Check the action question and each option for overlapping options (for example `close_distance` vs `run_in`, `defend` vs `roll_away`) and for compound wording.
2. **Verification questions in the same call.** For example "Is the enemy able to hit you before this lands?", used to overrule a risky pick. The fan-out study found these cheap and useful.
3. **Confidence gate.** Our own logs showed no link between confidence and the next second's HP swing (2026-09-25, ~3,000 decisions). The published gains come from escalating uncertain cases to something stronger, and we have no stronger fallback in real time. Low priority.
4. **Connection reuse.** The client already warms one connection (`client.warm()`). Confirm it is reused for every call.
