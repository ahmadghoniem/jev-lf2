# Experiment protocol

The question is not "can Jev press buttons" — that is already answered. The question is
**does Jev play better than the game's own COM**, and what makes it better.

## Phases

### Phase 0 — harness only, no API calls, costs nothing

Runs the executor with a hardcoded heuristic policy in Jev's place.

Goals:
1. Prove state extraction works with a match live — map the fighter objects inside the
   973-variable script scope. This is the main open task in the repo.
2. Prove input injection drives a character through a real fight.
3. Validate the frame-data reflexes: does the blocker actually block.
4. **Record the COM's own telemetry.** This is free and it produces the baseline Jev has
   to beat.
5. Calibrate the unknowns: MP cost units, what milk and beer actually restore, how long a
   pickup takes.

Exit criteria: a character completes a stage phase under harness control, and the log
contains one complete row per tick.

### Phase 1 — Jev and a COM on the same team

Jev's slot and a COM slot, **same character**, same stage, same difficulty, same waves.
Nobody human is playing.

This is the controlled comparison: identical conditions, two policies, side by side in the
same fight. It also answers "does Jev work at all", so the standalone Jev run is skipped —
it would spend credits to learn less.

Confound to watch: in stage mode allies do not damage each other, but they do compete for
items and can body-block. Log item contests so they can be excluded from analysis.

### Phase 2 — a human joins

You on P1, Jev, a COM. Then your brother's slot. Human presence changes enemy aggro and
item competition, so Phase 1 numbers are not directly comparable to Phase 2 numbers — each
phase gets its own baseline.

## Metrics, per fighter per run

| metric | why |
|---|---|
| damage dealt | raw offence |
| damage taken | defensive quality — where the COM is expected to be weakest |
| HP remaining at phase end | survival margin |
| deaths | hard failures |
| kills / assists | contribution share |
| damage per MP spent | resource discipline |
| items picked up, drinks consumed, weapon uptime | the strategic layer the COM ignores |
| time to clear the phase | overall efficiency |

## Telemetry row, one per tick

```jsonc
{
  "t": 1758230400123, "tick": 4821, "phase": 2,
  "state_sent": { },            // exactly what went to Jev
  "questions": "v3",            // schema version, not the full text
  "answers": { },               // with probabilities and confidence
  "latency_ms": 312,
  "usage": { "input_tokens": 612, "output_tokens": 38 },
  "action_taken": "dash_attack",
  "source": "jev",              // or "reflex" or "fallback" when the call failed
  "outcome_2s": { "dmg_dealt": 55, "dmg_taken": 0, "hp_delta": -0 }
}
```

`source` matters: it is the only way to tell how much of the performance is Jev and how
much is the executor's reflexes.

## Iteration loop

1. Run N matches under a fixed schema version.
2. Compare Jev's metrics against the COM's from the same runs.
3. Find the decisions that went wrong: filter for high confidence with bad `outcome_2s`.
   High confidence plus bad outcome means the **criteria are wrong**, not the model.
4. Revise the question schema.
5. **Replay the recorded states against the new schema offline** — no game time, batched
   calls, cheap. Only promote a schema to a live run once it beats the old one on the
   recorded set.

Step 5 is what makes a $5 credit stretch across real iteration.

## Ablations worth running

- **Executor alone** (Phase 0 heuristic) vs **executor + Jev**. If Jev doesn't clearly beat
  the heuristic, the harness is doing the work and the result means nothing.
- **Reflexes off**, Jev only. Shows how much the sub-100 ms layer contributes.
- **Tick rate**, 1 Hz vs 3 Hz. Shows whether latency is actually the binding constraint.
- **State richness**, 2 threats vs 4. Tests the "large irrelevant state distracts" warning
  on our own data.

## Hypotheses about the COM, to confirm in Phase 0

These are the gaps Jev is expected to exploit. Phase 0 logs the COM for free, so none of
them need to be assumed:

- it does not manage consumables strategically
- it does not focus-fire a weakened enemy
- its difficulty setting mostly changes reaction and aggression, not strategy
- it uses weapons opportunistically rather than choosing the best one available
