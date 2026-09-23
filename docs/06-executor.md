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

## MP is stated, not tiered

Jev used to see its bar as `some` and a special as `expensive`, and could not
tell whether a 200 MP super arrow would leave anything for the next one. It sat
on a full bar for long stretches. Now the state gives the bar in numbers with
its refill (`430 of 500, refilling about 10 a second`, and a warning when the
bar is full and the refill is being thrown away), and every option that costs
MP says what it costs against the MP in hand: how many times it can be paid,
what is left after one, and whether that still buys a special or how many
seconds until it does.

Everything in that sentence comes from data, so it holds for every fighter.
Costs differ per character even within a kind of move (the Fa energy ball is
40 for Dennis and Davis, 75 for Firen, 100 for Freeze, 125 for Woody), so no
table by category would do. Two engine rules from px.js: a cost above 1000
carries HP in its thousands (`mp % 1000` MP and `10 * floor(mp / 1000)` HP, so
Firen's explosion at 4300 is 300 MP and 40 HP), and the refill is
`1 + floor((500 - hp) / 100)` per step, which measured 10, 20 and 30 MP a
second above 400, 301-400 and 201-300 HP.

A chosen `defend` also ends as soon as nothing is coming, by the same test
that offers it. Held until the next decision, it outlasted the star it was
answering by 0.5-1 s.

## Block and roll, and what a projectile does at range

Thrown weapons are blocked by the reflex, no longer stepped off in depth. In
the three Henry vs Rudolf runs of 2026-09-23, 1,113 of 1,462 hp was lost while
the reflex was stepping and 17 while blocking; a star's bdefend is 12, far under
the 60 that px.js lets through a guard.

Jev now has two defences, described against each other. `defend` goes up at
once but stays put, breaks after several hits and lets knockdown hits through.
`roll_away` is a double-tap away and Defend, which reaches frames 102-107 (no
hurt box, about 200 units of travel); it takes about 12 ticks to start, so a
chosen roll replaces the thrown-weapon block only when the weapon is at least
that far out. Before this the block overruled every roll chosen against a star.

Projectile options no longer all say "reaches any distance". Each spawned
object's frame chain is walked as distance bands (`wait * dvx` per frame); a
chain that ends on 1000 has a range, one that loops flies until it hits. Henry's
blastpush is 80 to about 220, 55 to 385, 20 to 495, 5 to 605, then gone, which
the runs bear out (80 at 50-249, 55 at 250-299, 20 at 400-449); his super arrow
keeps 50 at any distance. The option states the damage at the enemy's current
distance and is withdrawn once the enemy is past the end of it. Things that
travel under 100 (explosions, Firen's flame trail) are placed, not thrown, and
get no bands.

## Notes from a paused game

Esc pauses the game, and while it is paused a note box opens at the top of the
screen. Enter saves a note (several are fine), Shift+Enter starts a new line,
and Esc saves whatever is typed and resumes. Typed keys stop at the box, so the
game's own pause keys (Q restarts, N steps, H, Z) do nothing while it has focus;
click the game to give them back. The box follows the game's own `pause` flag
on `Sh7E`, not a count of Esc presses.

While paused the loop asks nothing and presses nothing, drops any answer still
in flight, and adds the paused time back to the run. Notes land in
`runs/<id>/notes.jsonl` against the tick the pause began on, and
`node scripts/notes.mjs runs/<id>` prints the three seconds before each one and
one after: what Jev was offered and chose, reflex overrides, weapons in flight,
and every hit.

## Starting fast

`play.mjs` puts the panel up and opens the Jev connection (one tiny question,
`client.warm()`) before the fight, and checks only the decisive attack input
unless it fails. The full five-check probe used to take about three seconds of
a live fight in which Rudolf was free to hit a fighter walking left and right
on its own, and the first decision was a cold 700-900 ms call.

## From the first annotated match (2026-09-23T17-25-47)

Ten notes, and what each turned into:

- **Firing at an enemy off the screen** (five notes). The view is 794 units
  wide and follows Henry, clamped at the stage ends (`Sh7E.ph` is the stage
  width). Every flagged shot had Rudolf 398 or more away. Off the screen, no
  ranged option is offered, `close_distance` says why, and an aimed attack
  already under way walks toward the enemy instead of firing.
- **Blastpush into a downed enemy, with a block first.** The "block" is the
  Defend press that starts D>A. The special now holds its last press while the
  target is down, instead of spending the MP.
- **Facing away and blocking at nothing.** The roll was a blind burst: fired
  while Henry was knocked down, the double-tap was lost and the Defend press
  became a standing block facing away. It is now a stance that waits until
  Henry can act, holds the run until the game shows running, and only then
  presses Defend (or gives up). A started roll keeps the reflex off for a
  second.
- **Blocks the volley, never hits back.** An answer that landed while the
  reflex was blocking a star was thrown away. It is now kept, and takes the
  keys back as soon as the reflex lets go, if it is still fresh.

Matches restart from where the last one ended: attack from the summary, or
Esc, Q, Enter from a round still being fought. `menu.mjs --setup` is only for
changing fighters.
