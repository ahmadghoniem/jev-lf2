# The executor

`src/executor/` is the part that actually plays. It reads the arena 30 times a
second, asks for a decision about twice a second, and never lets the second rate
hold up the first.

Run it with [`scripts/play.mjs`](../scripts/play.mjs):

```
node scripts/play.mjs --name Deep --policy heuristic --seconds 90 --fresh
node scripts/play.mjs --name Deep --policy jev       --seconds 90 --fresh
```

`--fresh` restarts the match first, so a run is never half a corpse. `--policy
heuristic` costs nothing and is the control arm.

## The decision is never awaited

A Jev round trip is 300–1200 ms and a tick is 33 ms. Awaiting one would drop
thirty frames and hand the fight to whoever is still moving. So a request goes
out, the loop carries on, and the answer is adopted whenever it lands — unless
more than **1500 ms** have passed, in which case it describes a fight that has
moved on and is counted as `stale` instead. That bound is in milliseconds, not
ticks: the loop does not always hit its target rate, and a run pacing at 22 Hz
would otherwise get a 1.4-second window while believing it had one second.

Between decisions the character keeps playing: the reflex layer still fires and
the last chosen action still runs. A missed call degrades the policy; it never
freezes the fighter.

## Stances and bursts

An option becomes one of two things, because they behave differently:

- a **stance** is continuous and re-evaluated every tick — walking toward a
  target that is itself moving is not a fixed key sequence, and *go and pick up
  the blade* has to keep steering and then press attack once it arrives
- a **burst** is a timed sequence that owns the keyboard until it finishes — a
  dash attack is a double-tap, a jump and an attack with gaps between them, and
  re-deciding halfway through would just cancel it

`src/executor/keyboard.mjs` holds key state across ticks for this reason. Each
tick says what *should* be held rather than issuing a press, and only the seven
keys bound to the harness's slot are ever dispatched, so a bug here cannot reach
the humans' slots.

The keyboard also keeps the game's special-move reader in view. In px.js a
Defend press arms it, the next direction (or Jump) advances it, and an Attack or
Jump after that fires the special; only another key press resets it, never
time. The harness blocks, turns and steps constantly, so it was typing
specials by accident — Henry's 350-MP flute in the middle of a dodge, a
blastpush off a turn tap before a shot. Before a press that would complete the
sequence, the keyboard taps a direction the reader is not waiting for, one
frame earlier. Presses that belong to a chosen special are marked `intended`
and pass through.

## A run ends when the match does

The loop stops three seconds after the enemy is gone or our fighter is
confirmed dead, and records `won` or `lost` (otherwise `time`). Before this,
two of three runs spent over half their Jev calls on an empty stage.

## Only executable options are offered

Offering an option that cannot be carried out would quietly corrupt the
experiment — the answer would be recorded and the action would not happen.
`planAction` returns `null` for anything unsupported and those options are
dropped **before** the question is built. Specials are supported: a `hit_*`
input maps to a Defend, direction, button sequence in `SPECIAL_SEQUENCE`, and
`scripts/prove-specials.mjs` confirmed every timing window from 50/70 to
120/200 ms fires; a special whose input has no mapping is still dropped.

That interacts with the option cap, and the first live run showed how: the four
melee slots went to the heaviest variants and dropped `punch`, the one attack
that is always available and free. Options are now filtered by executability
before the cap applies, and the basic attack is always kept.

## Attribution

Every tick logs `source`: `jev`, `heuristic`, `reflex` or `idle`. The reflex
layer can overrule a decision — if a hitbox is about to go live within reach it
blocks, whatever was chosen — so without that field a good result could be the
reflexes' work and get credited to the policy. The "reflexes off" ablation in
[03-experiments.md](03-experiments.md) is what separates them properly.

## The overlay

`--overlay` is on by default; `--no-overlay` turns it off and `--keep-overlay`
leaves it on screen after a run.

The game's interface is DOM rather than canvas, so the panel is DOM too and
lands in the same layer instead of fighting the renderer. It borrows the game's
palette — the `rgb(16,32,108)` panel and `rgb(90,119,216)` border used
throughout — and then breaks from it deliberately with an amber edge, an amber
title and a monospace readout. The game uses neither anywhere, so nothing on
screen can be mistaken for the game's own HUD.

What it shows is the part of a decision a recording cannot show you while it is
happening: the options that were on the table, how close the runner-up was,
the confidence and the round trip, and whether the action on screen came from
Jev or from the reflex layer overruling it. The badge names the source, so a
block that the reflex layer forced never reads as Jev's idea.

It is one-way and inert — `pointer-events: none`, no key handlers, and a draw
failure disables the panel rather than interrupting the fight. Updates are
throttled to 10 Hz, except a new decision, which always draws.

## Measured on the first live runs

| | |
|---|---|
| pool read | 3 ms median, 6 ms p95 |
| decisions in 90 s | 57, of which 1 missed and 0 stale |
| round trip | 700–918 ms cold, ~300 ms once warm |
| input tokens per call | ~1,160 |
| schema files per run | 1 |

The cold round trip is why the per-call deadline is **1400 ms** and not 900: at
900 the first three calls of a run all missed, and then latency settled to a
third of that once the connection was warm.
