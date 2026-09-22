# Experiment protocol

The question is not "can Jev press buttons" — that is answered. The question is
**does Jev play better than the game's own COM**, and what makes it better.

## Phases

### Phase 0 — harness only, no API calls, costs nothing

The executor runs a hardcoded heuristic in Jev's place.

1. ~~Prove state extraction works with a match live~~ — done, see
   [05-live-state.md](05-live-state.md).
2. ~~Prove synthetic keys reach the game on a slot no human can press~~ — done.
   P4 is rebound to F13–F19 and joins a match on a dispatched `F17`.
3. ~~Prove those keys drive a character through a real fight, not just menus~~ —
   done. `scripts/prove-input.mjs` presses a key and reads the consequence out
   of the entity pool: walk left −100 units, walk right +100, jump to height
   −86, attack entering punch frames 65–67, defend entering frame 110. It waits
   for the fighter to be actionable first, because a knocked-down character
   ignores input and the first run failed for that reason alone.
4. ~~Wire the executor: reads to options to a decision to keys to telemetry~~ —
   done, see [06-executor.md](06-executor.md). Both policies run end to end.
5. Validate the frame-data reflexes: does the blocker actually block.
6. **Record the COM's own telemetry.** Free, and it produces the baseline. First
   recording taken: 75 s, four fighters, 19,581 tick rows.
7. ~~Work out which entity field is HP, which is dark HP, which is MP~~ — done
   from the first recording, no extra runs needed. `qe` HP, `$e` dark HP, `je`
   MP, `Ke` HP max. See [05-live-state.md](05-live-state.md#entity-fields).
8. Calibrate what milk and beer restore, and how long a pickup takes.

Exit criteria: a character completes a stage phase under harness control, and
`ticks.jsonl` holds one complete row per tick.

**Measured, so the loop no longer has to guess its own rate:** one read of the
whole entity pool costs **3 ms at the median and 6 ms at the 95th percentile**.
An uncapped loop samples at about 260 Hz. The game advances 30 times a second,
so the recorder caps itself at 30 Hz — the constraint on the executor is the Jev
round trip, not the connection.

### Phase 1 — Jev and a COM, same character

Jev's slot and a COM slot, **same character**, same stage, same difficulty, same
waves, nobody human playing. Identical conditions, two policies, side by side in
the same fight. It also answers "does Jev work at all", so a standalone Jev run
is skipped — it would spend credits to learn less.

Start with one character so the comparison has no confounds. The profiles in
`build/_profiles.json` cover all 23 fighters, so widening the test later is a
configuration change, not new code. Two characters are worth running eventually
because they test different things:

- a `melee` character (Bandit, Deep) tests spacing and commitment
- a `ranged` character (Henry) tests whether Jev exploits the archetype at all —
  a policy that walks Henry into punching range is measurably wrong

Confound to watch: in stage mode allies do not damage each other, but they do
compete for items and can body-block. Log item contests so they can be excluded.

### Phase 2 — a human joins

You on P1, Jev, a COM, then your brother's slot. Human presence changes enemy
aggro and item competition, so Phase 1 numbers are not comparable to Phase 2
numbers; each phase gets its own baseline.

## Setup, through the menus

Everything needed is reachable without touching the game's files:

- **Game Start → Stage Mode** — character select, 8 slots
- **"How many Computer Players?"** — 0 to 7, which is how the COM opponent and
  the COM control arm are added
- the pre-fight panel sets **Background** and **Difficulty**, so difficulty is a
  logged run parameter rather than an assumption

## Metrics

The game's own end-of-stage screen already reports per-player totals. Those are
worth recording as an independent check, but they are a summary at the end of a
run and cannot say *why*. Everything in the second table exists only because the
harness logs every tick, and that is where the feedback loop lives.

**Also available from the game's result screen**

| metric | why |
|---|---|
| damage dealt / taken | raw offence and defence |
| HP remaining at phase end | survival margin |
| deaths | hard failures |
| kills | contribution share |
| time to clear the phase | overall efficiency |

**Only from telemetry**

| metric | why |
|---|---|
| damage per MP spent | resource discipline, invisible in the summary |
| share of actions sourced `jev` vs `reflex` vs `fallback` | how much of the result is actually Jev |
| decision latency distribution, and miss rate | whether 2 Hz is enough |
| high-confidence decisions with bad outcomes | the criteria are wrong, not the model |
| time spent inside vs outside own attack reach | whether an archer is being played as an archer |
| whiff rate: attacks started with nothing in reach | the clearest single quality signal |
| blocks landed against incoming itrs the reflex layer saw | does the reflex layer work |
| item contests lost, weapon uptime, drinks consumed | the strategic layer the COM ignores |
| damage taken while recovering from a committed move | punishment for over-commitment |

## What gets logged

`src/telemetry/log.mjs` writes one directory per run, two streams because they
run at different rates and get read for different reasons:

| file | rate | contents |
|---|---|---|
| `ticks.jsonl` | 30 Hz | the arena: own frame/state/hp/mp/position, each threat's frame and offset, items, the action taken and its `source` |
| `judgements.jsonl` | ~2 Hz | the exact `state` sent, the schema id, the full answer with probabilities and confidence, latency, `usage`, request id — and the misses, because a miss is data |

The question schema is written once per run as `schema-<hash>.json`, but only
its stable part: the `action` and `target` options are rebuilt every tick from
what is on the ground, so hashing the whole set wrote a near-identical schema
file on almost every tick. The live options ride on the judgement row instead.
Both designs were built and measured over 2000 realistic ticks before choosing —
1999 schema files and 6.94 MB the first way, 1 file and 4.56 MB the second, with
the second ahead from the very first tick. Numbers in
[`bench/schema-ab.md`](../bench/schema-ab.md).

`manifest.json` closes the run with configuration, counts and totals.

Storing the verbatim `state` on every judgement is what makes replay possible,
and replay is what makes a $5 credit stretch.

## Iteration loop

1. Run N matches under a fixed schema.
2. Compare Jev's metrics against the COM's from the same runs.
3. Find the decisions that went wrong: filter for high confidence with a bad
   outcome window. High confidence plus bad outcome means the **criteria are
   wrong**, not the model.
4. Revise the question schema.
5. **Replay the recorded states against the new schema offline** — no game time,
   batched, cheap. Promote a schema to a live run only once it beats the old one
   on the recorded set.

## Ablations worth running

- **Executor alone** (Phase 0 heuristic) vs **executor + Jev**. If Jev doesn't
  clearly beat the heuristic, the harness is doing the work and the result means
  nothing.
- **Reflexes off**, Jev only. Shows how much the sub-100 ms layer contributes.
- **Tick rate**, 1 Hz vs 2 Hz. Shows whether latency is the binding constraint.
- **State richness**, 2 threats vs 4. Tests the "large irrelevant state
  distracts" warning on our own data.
- **Options withheld**: give Jev only `advance / retreat / attack` instead of the
  full priced option set. Tests whether the option builder is carrying the
  result.

## Hypotheses about the COM, to confirm in Phase 0

Phase 0 logs the COM for free, so none of these need to be assumed:

- it does not manage consumables strategically
- it does not focus-fire a weakened enemy
- its difficulty setting mostly changes reaction and aggression, not strategy
- it uses weapons opportunistically rather than choosing the best one available
- it does not play archetype-correctly: an archer COM still closes distance
