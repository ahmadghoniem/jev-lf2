# Live state from a running match

Phase 0's blocking question — can the harness read the arena while a fight is
running — is answered: yes, completely, and without computer vision.

## How the state is reached

The bundle keeps nothing on `window`. Game state lives in a top-level script
scope, reachable through the `[[Scopes]]` of any function the page defined
(`onerror` works). That scope holds 972 variables, including every class
constructor — but **not** the fighters.

The entity objects are found instead by heap query:

1. read the class constructor out of the script scope,
2. take its `prototype`,
3. `Runtime.queryObjects({ prototypeObjectId })` returns every live instance.

That returns a real JavaScript array, so one `Runtime.callFunctionOn` summarizes
the whole arena in a single round trip. A scope object cannot do this —
`callFunctionOn` against a scope sees almost nothing, which is why snapshots of
the scope go through `getProperties` instead.

The Debugger domain is never enabled, so the obfuscator's debug protection never
triggers.

## Class map — VERIFIED by instance count

Instance counts from a live match match the parser's counts from `_res_data`
exactly, which is what identifies each obfuscated class:

| class | instances | parser count | meaning |
|---|---|---|---|
| `GDLT` | 5974 | 5974 frames | a parsed frame |
| `_IUN` | 5070 | 5070 `<b>` | bdy, hurt box |
| `UNzS` | 4152 | 4152 `<w>` | wpoint |
| `LFN6` | 2906 | 2906 `<bp>` | bpoint |
| `WlEE` | 1979 | 1942 `<i>` | itr, attack box |
| `AkRS` | 521 | 521 `<c>` | cpoint |
| `Kahe` | 114 | 114 `<o>` | opoint |
| `TIJj` | 65 | 65 data files | a parsed data file |
| `LWAh` | 400 | — | **the entity pool** |
| `HJUP` | 72 | — | sprite wrapper |

`WlEE` runs 37 over the `<i>` count because weapon `<wsl>` entries build itrs too.

## The entity pool

`LWAh` is a fixed pool of 400 slots covering everything in the arena — fighters,
weapons, projectiles, debris. A slot is in play when it has a position; unused
slots sit at the origin.

Each entity carries `e0`, a reference to its parsed data file, which is what
joins a live object to the tables in `build/`:

```
slot   0  John             id 2    type 0  (1660,0,409)
slot  11  Henry            id 4    type 0  (1383,0,408)
slot  50  weapon5          id 121  type 4  (761,0,410)
slot  51  weapon0          id 100  type 1  (1926,0,352)
slot  53  henry_arrow1     id 201  type 1  (1740,0,320)
slot  59  broken_weapon    id 999  type 5  (1643,0,409)
```

`e0.type` is the `_data.txt` type, so fighters are `type === 0`, melee weapons
`1`, throwables `2`, baseball `4`, drinks `6`. Weapon pickups and the enemy's
projectiles are visible in the same read as the fighters.

## Entity fields

Coordinates are plain: **`x` horizontal, `y` vertical (negative is up), `z`
depth**. `os` / `rs` / `ns` hold the same three as floats before rounding.

### Confirmed against the parsed frame data

| field | meaning | evidence |
|---|---|---|
| `index` | slot number | matches the pool position |
| `Ts` | **current frame id** | John sat at `Ts 231`, and `john-r` frame 231 is `state 14`, lying — he had just been knocked down. Henry stepped `3 → 4`, which is `henry-r`'s standing loop. |
| `waiting` | **ticks elapsed in the current frame** | counted `1 … 8` while Henry held frame 3, whose `wait` is exactly 8 |
| `Lu` `ku` `$u` | track `Ts` | move with it; current/previous bookkeeping, not yet separated |
| `e0` | the entity's data file | carries `name`, `filename`, `id`, `type` |

`Ts` plus `waiting` is the whole reflex layer: the frame id looks up the itr and
its damage in `build/<character>.json`, and `wait - waiting` is exactly how many
ticks remain before the next frame lands.

### Confirmed against a recorded match

A 75-second recording of four fighters (19,581 ticks, one idle) settles these.
Idle Deep is what makes it clean: it received damage and never spent anything,
so the field that only fell is health and the field that only rose is MP.

| field | meaning | evidence over the whole recording |
|---|---|---|
| `qe` | **HP** | falls only around a hit, worst single tick −85; regenerates about +1 every 400 ms; goes **negative** on a knockout (−44, −48, −43) and stops moving there |
| `$e` | **dark HP** — the ceiling `qe` regenerates back toward | `$e >= qe` in all 19,581 rows, zero violations; it never rises for anyone, so it is the permanent share of the damage |
| `je` | **MP** | idle Deep: 150 rises and **0 falls** with no input at all; the three COMs spend it in chunks, worst −225 on a Davis special, then it resumes climbing |
| `Ke` | **HP max** | exactly `500` for all four fighters for the entire run, and it bounds both `qe` and `$e` |
| `As` | **facing** | two states, flips with direction of travel; on idle Deep it only flips when knocked back |
| `group` | team | `10` for the player slot, `21` / `22` / `23` for the three COMs |
| `id` | character id | `1` Deep, `11` Davis, `6` Louis, `7` Firen — joins to `build/_index.json` |
| `bo` | human-controlled | `true` for the player slot, `false` for every COM |
| `f` | sprite index (`pic`) | small, changes with `Ts` |
| `left` `right` `attack` | held inputs | named in clear, all `0` while idle |

**MP has no max field in the pool.** `je` was seen as high as **505** while `Ke`
is a hard `500`, so the two are not the same cap. Either the maximum is
hardcoded in the engine or regeneration overshoots and clamps a tick later.
Treat 500 as the practical cap and bucket MP rather than comparing it to `Ke`.

Worked traces, and the script that produced them, are in
[`bench/field-classification.md`](../bench/field-classification.md)
(`scripts/classify-fields.mjs`, which runs over any recorded run directory).

### Still unconfirmed

- what milk and beer restore, and how long drinking takes
- how long a weapon pickup takes
- the `hit_*` input strings (D→F→A and so on), needed before combo macros

## The window has to be visible

Chromium stops the frame loop for a window that is not on screen. When that
happens the game stops with it: entity reads come back frozen and
`Page.captureScreenshot` never returns.

`Emulation.setFocusEmulationEnabled` plus `Page.setWebLifecycleState('active')`
restarts the loop — the CDP client now sends both on connect — but an occluded
window is still throttled to roughly **4 frames a second**. That is enough to
confirm state is advancing and useless for anything timed.

**Run experiments with the game window on screen.** Treat a suspiciously low
frame rate as an occluded window before suspecting the harness.

## Key bindings live in localStorage

The remaster stores all four players' controls as one delimited string under an
obfuscated `localStorage` key (`PoeS*z@y` on this machine, found by value rather
than by name since the name is not stable across builds):

```
P1©ArrowUp©ArrowDown©ArrowLeft©ArrowRight©Enter©ShiftRight©Quote©None©None©None©P2©…
```

Ten slots per player, in order: **up, down, left, right, attack, jump, defend**,
then three unused. Confirmed in game — P1's fifth entry is `Enter`, and pressing
Enter is what joins a slot on the character-select screen.

Values are DOM `event.code` strings, and the game compares them directly, so
**F13–F24 work**: keys with no physical equivalent on a normal keyboard, which
is exactly what the harness's player slot needs. Verified by rebinding P4 to
F13–F19 and joining a slot with a synthetic `F17`. Writing the string directly
also skips the rebinding screen, which would otherwise need a key held down per
binding.

The game reads the bindings once at start-up, so a change needs a page reload.

`scripts/bind-keys.mjs` does all of this, and backs the original up to
`build/keybinds-backup.json` before its first write. That file is not committed,
so the defaults are recorded here too:

| | up | down | left | right | attack | jump | defend |
|---|---|---|---|---|---|---|---|
| P1 | ArrowUp | ArrowDown | ArrowLeft | ArrowRight | Enter | ShiftRight | Quote |
| P2 | KeyW | KeyX | KeyA | KeyD | KeyS | Tab | Backquote |
| P3 | Numpad8 | Numpad2 | Numpad4 | Numpad6 | Numpad5 | Numpad0 | NumpadAdd |
| P4 | KeyI | Comma | KeyJ | KeyL | KeyK | Space | Period |

**P4 is the harness slot**, now bound to F13–F19. P1, P2 and P3 are untouched,
so two humans and a spare keyboard layout are all still available.

## Getting into a match

Every screen is reachable with synthetic keys; no file patching, no mods.

1. title screen — `Enter` selects **VS Mode**
2. character select — each slot joins with that player's own attack key
3. attack steps down the rows (fighter, team), then a **"How many Computer
   Players?"** prompt takes 0–7
4. a pre-fight panel offers Fight / Reset / Background / Difficulty, so
   difficulty is a recorded run parameter rather than an assumption

## Tools

| script | what it does |
|---|---|
| `scripts/launch-game.mjs` | starts the game with the CDP port open, or reports one already running |
| `scripts/scope-snapshot.mjs` | snapshots the 972-variable script scope; `--diff a b` compares two by shape |
| `scripts/find-instances.mjs` | counts live instances of every class; names one class to dump it |
| `scripts/entity-dump.mjs` | every entity in play, identity resolved; `--full` for all fields |
| `scripts/watch-fields.mjs` | samples fighters over time and reports which fields moved |
| `scripts/scene-dump.mjs` | the PixiJS display list — rendering only, no game state |
| `scripts/fn-scopes.mjs` | closure scopes of a function, used to find the game loop |
| `scripts/bind-keys.mjs` | shows and rewrites the key bindings; `--assign P4 --from F13 --reload` |
| `scripts/record-baseline.mjs` | records a match to `runs/`, measures read latency, reports which fields moved |

The game loop itself is the ticker listener `() => DQcu()` on `app._ticker`.
