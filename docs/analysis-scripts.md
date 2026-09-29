# Writing analysis scripts over runs/

Lessons from building the scripts in `scratch/` (listed in `scratch/INDEX.md`).
Check field names against a current `ticks.jsonl` line before relying on them.

## Files in a run

- `runs/<id>/ticks.jsonl`: one line per loop tick. `judgements.jsonl`: one line
  per Jev ask, carrying the `tick` it was sent on and the options offered.
  `notes.jsonl`: the user's in-game notes. `manifest.json`: written when the run
  ends, so the run in progress and crashed runs have none; filter with
  `fs.existsSync`.
- The manifest holds `label` (the series arm), `character`, `difficulty`,
  `decideEveryMs`, the trial flags on (`painHint`, `reachTime`; older runs also
  `staggerHint`, `useRecent`, `holdAttack`, `smartBlock`, `skipBusyAsks`), `commit` (from
  73e4017 on) and `loop` (the loop's counters, including `outcome`).
- Wins: `manifest.loop.outcome` is `won`, `lost` or `time` (since
  2026-09-22T22-30). The series log prints the same at the end of each game
  line ("— won"). Don't infer the winner from the last tick's HP: the loop stops
  90 ticks after one side is gone and HP on the last tick can mislead.
- `runs/` also holds loose files (`shot.png`); list directories matching
  `^20` and skip runs under 100 ticks (menus, aborted starts).

## Tick fields

- Filter `r.me` (ticks before the match have none). `r.me` has frame, doing,
  hp, mp, x, z, facing, holding, guard. It has no `waiting`; enemies do.
- `threats[]`: slot, name, frame, doing, hp, dx, dz, facing, waiting,
  onScreen, vulnerable. dx and dz are enemy minus me. Match HP drops by `slot`
  across ticks, not by array index: the order changes.
- `keys` is the keys down after this tick's input. A press is a key in `keys`
  that was not in the previous tick's `keys`.
- `source` is `jev`, `reflex` or `idle`; `action` is the answer in force.
  An answer is a run of consecutive ticks with source `jev` and the same
  action. Jev giving the same action twice in a row merges into one run, so
  count asks from `judgements.jsonl`, not from answer runs.
- `lane` is set when any lane danger was found. It is not the gate the
  special stance uses (which also compares the danger's eta with the
  sequence's startup).
- `downFor`, `ownFor`: ticks left in the fighter's knockdown (-1 if it loops)
  or own move, on ticks where it is in one (`ownFor` from 73e4017).

## Frame and move data

- `framesFor(id)` in `src/lf2data/tables.mjs` returns a fighter's frames by
  id; `profileFor(name)` returns its profile. Names to ids: `build/_index.json`
  (entries with `type: 0`, field `character`).
- `build/_profiles.json` per fighter: `moves[]` with name, input, entry
  (first frame), mp, startupTicks, hitTicks, reach, damage, knocksDown,
  breaksGuard, homes. Answers are named `special_<move.name>`; a special
  fired if the fighter reached its `entry` frame within about 10 ticks.
- `ticksToEnd(frames, frameId, waiting)` in `src/lf2data/frames.mjs` counts
  ticks until a frame chain returns to standing; Infinity for loops.
- Frame numbers shared by all fighters: 110 block, 111 blocked hit, 112 guard
  broken, 102-107 roll, 180-191 falling, 222/224 stagger, 226-229 dance of pain,
  70 super punch (plain Attack on a dance-of-pain enemy).
- Game fall rule (px.js): each hit adds itr.fall (20 if 0). Over 60: falls.
  Over 40: dance of pain. Over 20: stagger. Entering the dance sets it to 60,
  and it drops 1 a tick outside hit-lag, so a hit on a dancing enemy knocks it
  down only if its fall is more than the ticks since the dance began (306 of
  306 of our hits, `scratch/dop-fall-rule.mjs`).

## Method

- When asking why the harness did something, replay the gates in the order
  the code checks them, tick by tick, from the tick fields. Labels built from
  proxies ("lane danger on half the ticks") were right 47-49% of the time
  (`scratch/never-started.mjs`).
- Batch arms differ by code as well as flags: compare by `label` and
  `commit`, and only runs on the same difficulty and matchup.
- Dealt and lost per 1000 ticks makes games of different length comparable;
  wins need 10+ games per arm to mean much (`scratch/dealt-sd.mjs`).
- `scratch/` and `runs/` are append-only for now: give every new script and
  log a name that does not exist yet.
- Scripts take `[since] [until]` run-id prefixes as arguments
  (`node scratch/x.mjs 2026-09-29T08-4`) rather than hard-coded run lists.
