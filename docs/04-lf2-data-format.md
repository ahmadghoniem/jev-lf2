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
| `mp` | MP cost against a 500 bar. A **negative** value is the engine's marker for a move that stays usable when MP runs short — the amount spent is still its absolute value. Henry's arrow is `mp -12`. |
| `hit_a` `hit_d` `hit_j` | combo transition on attack / defend / jump |
| `hit_Fa` `hit_Ua` `hit_Da` `hit_Uj` | combo transition on Forward+Attack, Up+Attack, Down+Attack, Up+Jump |
| `sound` | mp3 path |

The `hit_*` fields carry the **special** moves: input → target frame, with the
target frame holding the MP cost and the itr that does the damage.

They are not the whole move list. Bandit has no `hit_*` fields at all, and every
character's ordinary attacks are reached by fixed entry frames instead, which
the data names: `punch`, `super_punch`, `jump_attack`, `run_attack`,
`dash_attack`, `normal_weapon_atck` and the rest. `src/lf2data/profile.mjs`
walks both — the `hit_*` targets and the named entry frames — which is why
profiles exist for all 23 fighters and not only the ones with specials.

In LF2 these transitions fire on defend-prefixed combos — `hit_Fa` on D→F→A,
`hit_Ua` on D→↑→A. Confirm the exact input strings in game before wiring the
macros, since the remaster could have changed them.

## Derived fighting profiles

`node scripts/build-move-tables.mjs` writes `build/_profiles.json`: for every
character, each move with its kind, reach, damage, MP cost and startup, plus an
archetype derived from what the plain attack button does.

```
character       archetype  bare reach  cheapest ranged mp  basic attack
Bandit          melee              50                   -  melee 20 dmg
Henry           ranged             92                  12  ranged 70 dmg
Davis           mixed              54                  40  melee 20 dmg
```

Reach is measured from the fighter's own hurt box, not from the sprite origin,
because `centerx` is absent on most frames.

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

### itr kinds — which boxes actually hurt

Only some kinds are attacks, and reading the rest as damage produces nonsense:

| kind | meaning | counts as damage |
|---|---|---|
| 0 | ordinary attack | yes |
| 2 | pick-up box, present on punch frames | no |
| 5 | weapon-in-hand strength | no — `injury 789` here is a placeholder the engine replaces from the weapon's `<wsl>` |
| 6 | super punch | yes |

Henry's arrow reads as a 789-damage attack unless kind 5 is excluded; its real
damage is 25–70. No **character** frame carries a kind-5 itr — checked across
all 23 — so weapon damage is always the weapon object's business.

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

The live entity carries its current frame id in `Ts` and how far into it in
`waiting` (see [05-live-state.md](05-live-state.md)). Look the frame up in the
parsed table:

- has a live `<i>` with `injury` → an attack is connecting **now**
- `state 3` and the itr is a few frames ahead via `next`/`wait` → an attack is **coming**,
  and `wait - waiting` is exactly how many ticks remain before it lands
- `<b>` gives its hurt box, so the executor also knows where its own attack would land

Deterministic, local, zero network. The same information the engine itself uses.
