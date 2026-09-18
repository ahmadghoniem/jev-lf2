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

### Probable, not yet confirmed

| field | reading | why it is not settled |
|---|---|---|
| `qe` | HP | John read `-28` while lying after a knockout; Henry read `500` at full health |
| `Ke` | HP max | `500` on both, which is LF2's documented maximum |
| `$e` | dark HP (the trailing bar) | `274` on the knocked-out fighter, `500` on the healthy one |
| `je` | MP | `500` on Henry, but `501` on John, so it is not cleanly capped |
| `bo` | knocked out | `true` only on the fighter who was lying |
| `group` | team | `10` and `21` for two Independent fighters |
| `f` | sprite index (`pic`) | small and changes with `Ts` |
| `left` `right` `attack` | held inputs | named in clear, all `0` while idle |

Settle these by taking damage and spending MP with the values logged, not by
reasoning about them further.

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

The game loop itself is the ticker listener `() => DQcu()` on `app._ticker`.
