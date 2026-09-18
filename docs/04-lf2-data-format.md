# LF2 Remastered data format

`resources/app/_res_data/*.txt` — plain text, unencrypted, the classic LF2 format with
compact tag syntax. This is the foundation of the reflex layer, the move repertoire and the
item logic. Nothing here needs computer vision or reverse engineering.

## Object registry

`_data.txt` maps ids to files and types:

| type | meaning | ids seen |
|---|---|---|
| 0 | character | 0 (template), 1–11, 30–39, 50–52 |
| 1 | melee weapon | 100 stick, 101 hoe, 120 knife, 124 |
| 2 | throwable / heavy | 150 stone, 151 wooden box, 217/218 louis armour |
| 4 | baseball | 121 |
| 5 | criminal | 300 |
| 6 | drink | 122 milk, 123 beer |

`_stage.txt` defines every stage phase: enemy ids, hp, counts, spawn ratios, boss flags and
which items drop. Items are pre-announced by the data, so the harness knows a milk is coming
before it spawns.

## File structure

```
<bmp ... bmp>        header: name, sprite sheets, speeds, jump/dash physics, limb art
  <wsl ... wsl>      weapons only: damage table per attack type
<f N name ... f>     one block per frame
```

## Frame block

```
<f 61 -
   pic 11 state 3 wait 1 next 62
   <i kind 0 x 26 y 36 w 43 h 18 dvx 2 bdefend 16 injury 20 i>
   <b kind 0 x 18 y 16 w 31 h 68 b>
f>
```

Header line fields (all optional except `pic`):

| field | meaning |
|---|---|
| `pic` | sprite index |
| `state` | behaviour class — see table below |
| `wait` | ticks this frame is held |
| `next` | frame id to advance to (negative values are engine signals) |
| `centerx` / `centery` | sprite origin |
| `dvx` / `dvy` | velocity applied on entering the frame |
| `mp` | MP cost. Observed on Davis: 25, 40, 75, 225. The LF2 MP bar is widely documented as 0–500, which fits this range, but **confirm empirically** by logging MP before and after a special. |
| `hit_a` `hit_d` `hit_j` | combo transition on attack / defend / jump |
| `hit_Fa` `hit_Ua` `hit_Da` `hit_Uj` | combo transition on Forward+Attack, Up+Attack, Down+Attack, Up+Jump |
| `sound` | mp3 path |

The `hit_*` fields are the **complete move list, machine-readable**: input → target frame,
and the target frame carries the MP cost and the itr that does the damage. The move
repertoire does not need to be hand-written.

In LF2 these transitions fire on the defend-prefixed combos — `hit_Fa` on D→F→A,
`hit_Ua` on D→↑→A, and so on. Confirm the exact input strings in game before wiring the
macros, since the remaster could have changed them.

## Extracted move table

`node scripts/build-move-tables.mjs` parses all 65 files: **5974 frames, 206 moves,
1220 damaging frames**. Davis, as a spot check:

| input | entry frame | name | mp | startup | effect |
|---|---|---|---|---|---|
| Fa | 240 | ball1 | 40 | 4t | spawns object 207 |
| a | 247 / 253 / 259 / 264 | ball2–4 | 40 | 2–3t | spawns object 207 |
| Da | 270 | many_punch | 75 | 1t | 45 dmg |
| Ua | 300 | singlong | 225 | 1t | 85 dmg |
| a | 293 | — | 0 | 0t | 50 dmg |

Three entries come back `unresolved` (`a`→f89, `j`/`Uj`→f290, `d`→f999). f999 is an engine
sentinel rather than a real frame; the other two need a longer walk or lead to frames whose
damage comes from a spawned object. Worth closing before the macro layer is built.

## Tags inside a frame

| tag | count across all files | meaning |
|---|---|---|
| `<b ... b>` | 5070 | bdy — hurt box. Where this fighter can be hit. |
| `<w ... w>` | 4152 | weapon point — where a held weapon attaches, with `weaponact` |
| `<bp ... bp>` | 2906 | body point, used by the remaster's limb rendering |
| `<i ... i>` | 1942 | itr — interaction box. Attacks, catches, pickups. |
| `<c ... c>` | 521 | cpoint — catch point, for grabs and throws |
| `<o ... o>` | 114 | opoint — spawns an object, `oid` names it (e.g. 207 = a projectile) |

### itr attributes observed

`kind` `x` `y` `w` `h` (always present), then `injury` (1440), `bdefend` (1424),
`fall` (1384), `dvx` (1381), `vrest` (1231), `effect` (451), `dvy` (336), `arest` (144),
`caughtact` (99), `catchingact` (99), `zwidth` (53).

`injury` is damage. `fall` and `bdefend` decide whether the hit knocks down or breaks a
block. `effect 1` marks sharp/critical weapons.

## State values — VERIFIED by cross-referencing frame names

| state | meaning | evidence (frame names in `davis-r.txt`) |
|---|---|---|
| 1 | walking | `5:walking`, `12:heavy_obj_walk` |
| 2 | running | `9:running`, `16:heavy_obj_run` |
| 3 | attacking | `20:normal_weapon_atck`, `30:jump_weapon_atck`, `60:punch` |
| 4 | jumping | `210:jump` |
| 5 | dashing | `213:dash`, `216:dash` |
| 6 | rowing (air recovery) | `100:rowing` |
| 7 | defending | `110:defend`, `95:dash_defend` |
| 8 | broken defend | `112:broken_defend` |
| 9 | catching | `120:catching`, `232:throw_lying_man` |
| 10 | caught | `130:picked_caught` |
| 11 | injured | `220:injured` |
| 12 | falling | `180:falling` |
| 13 | frozen | `201` |
| 14 | lying | `230:lying` |
| 15 | throwing weapon | `45:light_weapon_thw`, `50:heavy_weapon_thw`, `19:heavy_stop_run` |
| 16 | (unnamed, frames 226–229) | follows `injured` — likely recovery |
| 17 | **drinking** | `55:weapon_drink` |
| 18 | burning | `203:fire` |
| 1000+ | weapon/item states | milk and beer frames use `state 1000` |

Key frames for item handling: `115:picking_light`, `116:picking_heavy`, `55:weapon_drink`.

## Weapon damage tables (`<wsl>`)

Melee damage per attack type, pulled from the weapon files:

| weapon | id | normal | jump | run | dash | effect |
|---|---|---|---|---|---|---|
| stick | 100 | 40 | 40 | 50 | 50 | — |
| hoe | 101 | 45 | 45 | 55 | 55 | 1 |
| knife | 120 | 45 | 45 | 55 | 55 | 1 |
| baseball | 121 | 40 | 60 | 85 | **100** | 1 |
| milk | 122 | 40 | 60 | 85 | **100** | — |
| weapon9 | 124 | 45 | 45 | 55 | 55 | 1 |

Stone (150), wooden box (151) and beer (123) have no `<wsl>` — they are throwables and do
their damage on impact.

All of them also carry `weapon_hp` (450 for drinks) and `weapon_drop_hurt` (35).

## How the reflex layer uses this

Read the opponent's current **frame id** from game state, look it up in the parsed table:

- has a live `<i>` with `injury` → an attack is connecting **now**
- `state 3` and the itr is a few frames ahead via `next`/`wait` → an attack is **coming**,
  and the exact number of ticks until it lands is known
- `<b>` gives its hurt box, so the executor also knows where its own attack would land

Deterministic, local, zero network. The same information the engine itself uses.
