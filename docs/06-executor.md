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

A Jev round trip is 300–900 ms and a tick is 33 ms. Awaiting one would drop ten
frames and hand the fight to whoever is still moving. So a request goes out
tagged with the tick it was asked at, the loop carries on, and the answer is
adopted whenever it lands — unless more than **30 ticks** have passed, in which
case it describes a fight that has moved on and is counted as `stale` instead.

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

## Only executable options are offered

The special moves need `hit_*` input strings that are still unconfirmed, so the
executor cannot perform them. Offering an option that cannot be carried out
would quietly corrupt the experiment — the answer would be recorded and the
action would not happen. `planAction` returns `null` for anything unsupported
and those options are dropped **before** the question is built.

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

## Measured on the first live runs

| | |
|---|---|
| pool read | 3 ms median, 6 ms p95 |
| decisions in 90 s | 57, of which 1 missed and 0 stale |
| round trip | 700–918 ms cold, ~300 ms once warm |
| input tokens per call | ~1,160 |
| schema files per run | 1 |

The cold round trip is why the per-call deadline is **1200 ms** and not 900: at
900 the first three calls of a run all missed, and then latency settled to a
third of that once the connection was warm.
