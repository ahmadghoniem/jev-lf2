# Fighter Field Classification Report

- **Run Directory**: `runs/2026-09-18T23-55-08`
- **Total Ticks Analyzed**: 19,581
- **Fighters in Play**: Deep (slot 0), Davis (slot 11), Louis (slot 12), Firen (slot 13)
- **Idle Baseline Fighter**: Deep (slot 0, no controller inputs applied)

---

## Executive Summary & Conclusions

| Role | Classified Field | Confidence | Summary Rationale |
|---|---|---|---|
| **HP (Live Hit Points)** | `qe` (or `$e`) | **High (`qe` = Live HP, `$e` = Permanent HP / Ceiling)** | `qe` drops by full attack damage on hits (up to -85 in one tick), slowly regenerates (+1 every ~400ms) up to `$e`, and drops negative (-44) upon fatal knockout where regeneration ceases. If defined as the strictly non-increasing damage ceiling, `$e` never rises (rises=0) and represents permanent unrecoverable health. |
| **Dark HP (Lagging Ceiling)** | `$e` (or `qe`) | **High (`$e >= qe` across 100% of ticks)** | `$e` satisfies `$e >= qe` across all 78,324 samples with zero violations. It drops on hits (e.g. 6–28 points) and stays fixed as a monotone non-increasing staircase, holding the upper ceiling for live HP recovery. |
| **MP (Mana / Special Gauge)** | `je` | **Certain (100%)** | Starts at 211, regenerates continuously with zero input on idle Deep (150 rises, 0 falls), is spent in discrete chunks on active fighters (up to -224 on special moves), and caps at ~501. |
| **HP Max (Health Cap)** | `Ke` | **Certain (100%)** | Invariant constant of `500` across all four fighters for the entirety of the match, precisely bounding both `qe` and `$e` (which start at 500). |
| **MP Max (Mana Cap)** | `Ke` (or hardcoded) | **Probable (shared cap) / Data does not isolate separate field** | No distinct constant field equal to 500 exists other than `Ke`. Observed MP peaks at 501–505. `Ke` (500) acts as the nominal cap, or the game engine hardcodes 500 in code. |

---

## Ranked Candidate Evidence Tables

### 1. MP (Mana Points)

Continuous passive regeneration on idle fighters, discrete consumption on special moves, bounded above.

| Field | First (Idle) | Min | Max | Total Rises | Total Falls | Max Single Drop | Holds All? | Score | Evidence / Notes |
|---|---|---|---|---|---|---|---|---|---|
| `je` | 211 | 9 | 505 | 1625 | 35 | 225 | Yes (4/4) | 100 | monotone rising on idle player (zero falls); continuous steady regeneration across all fighters; discrete expenditure drops (>=20) on active fighters; bounded within typical LF2 bar scale (~500) |
| `t3` | -1 | -1 | 12 | 3 | 0 | 0 | Yes (4/4) | 40 | monotone rising on idle player (zero falls) |
| `U3` | 0 | 0 | 647 | 67 | 0 | 0 | Yes (4/4) | 40 | monotone rising on idle player (zero falls) |

### 2. HP (Live Hit Points)

Decreases when hits connect, bounds live state, drops below zero on knockout.

| Field | First (Idle) | Min | Max | Total Rises | Total Falls | Max Single Drop | Holds All? | Score | Evidence / Notes |
|---|---|---|---|---|---|---|---|---|---|
| `qe` | 500 | -48 | 500 | 411 | 73 | 85 | Yes (4/4) | 100 | initializes at canonical match health (500); decreases when hits land on idle player (21 drops); slow natural HP recovery (+1/tick) capped by dark HP; takes full injury hit drops (max single drop: 85); drops negative on knockout (-44) |
| `$e` | 500 | 273 | 500 | 0 | 69 | 30 | Yes (4/4) | 90 | initializes at canonical match health (500); decreases when hits land on idle player (21 drops); strict non-increasing staircase on idle fighter (rises=0); takes full injury hit drops (max single drop: 30) |
| `As` | 0 | 0 | 1 | 31 | 30 | 1 | Yes (4/4) | 45 | decreases when hits land on idle player (1 drops); slow natural HP recovery (+1/tick) capped by dark HP |
| `z3` | 0 | 0 | 2 | 61 | 63 | 1 | Yes (4/4) | 45 | decreases when hits land on idle player (5 drops); slow natural HP recovery (+1/tick) capped by dark HP |

### 3. Dark HP (Lagging Health Ceiling)

Upper bound of current HP (`darkHp >= hp`), steps down on injury, bounds recovery.

| Field | First (Idle) | Min | Max | Total Rises | Total Falls | Max Single Drop | Holds All? | Score | Evidence / Notes |
|---|---|---|---|---|---|---|---|---|---|
| `$e` | 500 | 273 | 500 | 0 | 69 | 30 | Yes (4/4) | 100 | initializes at full health ceiling (500); drops on damage (21 drops); monotone non-increasing (permanent damage ceiling, never rises); retains positive ceiling at match end (285) |
| `qe` | 500 | -48 | 500 | 411 | 73 | 85 | Yes (4/4) | 50 | initializes at full health ceiling (500); drops on damage (21 drops) |
| `Hu` | 0 | 0 | 2 | 67 | 66 | 2 | Yes (4/4) | 25 | drops on damage (19 drops) |
| `Qu` | 0 | -20 | 15 | 66 | 65 | 20 | Yes (4/4) | 25 | drops on damage (19 drops) |

### 4. HP Max (Health Maximum Cap)

Constant field invariant across the match, matching starting health and bounding HP.

| Field | First (Idle) | Min | Max | Total Rises | Total Falls | Max Single Drop | Holds All? | Score | Evidence / Notes |
|---|---|---|---|---|---|---|---|---|---|
| `Ke` | 500 | 500 | 500 | 0 | 0 | 0 | Yes (4/4) | 80 | invariant constant exactly matching initial health (500); strictly bounds all observed health states (>= 500) |
| `L3` | 1000 | 1000 | 1000 | 0 | 0 | 0 | Yes (4/4) | 30 | strictly bounds all observed health states (>= 500) |
| `I3` | 1000 | 1000 | 1000 | 0 | 0 | 0 | Yes (4/4) | 30 | strictly bounds all observed health states (>= 500) |
| `T3` | 1000 | 1000 | 1000 | 0 | 0 | 0 | Yes (4/4) | 30 | strictly bounds all observed health states (>= 500) |

### 5. MP Max (Mana Maximum Cap)

Constant field bounding the observed MP regeneration ceiling (~500).

| Field | First (Idle) | Min | Max | Total Rises | Total Falls | Max Single Drop | Holds All? | Score | Evidence / Notes |
|---|---|---|---|---|---|---|---|---|---|
| `Ke` | 500 | 500 | 500 | 0 | 0 | 0 | Yes (4/4) | 50 | constant bounding observed MP peak (~505) |

---

## Detailed Analysis of HP vs Dark HP (`qe` vs `$e`)

The relationship between `qe` and `$e` resolves a classic Little Fighter 2 design mechanic:
1. **Zero Violations of Ceiling Constraint**: In all **78,324** fighter states across the recording, **`$e >= qe` holds true in 100% of ticks**.
2. **Hit Dynamics**: When an attack lands, `qe` absorbs the full impact (e.g. -20 to -85 HP in a single tick). Field `$e` absorbs partial/permanent damage (e.g. -6 to -28 HP).
3. **Recovery Dynamics**: When a fighter is left idle, `qe` slowly recovers (+1 point every ~400 ms) until it reaches `$e`. Field `$e` never regenerates on its own (`rises = 0` across the entire match for all four fighters).
4. **Knockout Threshold**: When fatal damage lands, `qe` plunges below zero (`-44` on Deep, `-48` on Louis, `-43` on Firen), marking true knockout, while `$e` remains positive (`285`, `294`, `273`).
5. **Duality in Terminology**:
   - In LF2 internal terminology: **`qe` is live HP** (current red bar), and **`$e` is Dark HP** (dark red upper bound).
   - In terms of pure mathematical staircases: **`$e` is the monotone non-increasing staircase** (it strictly never rises), whereas **`qe` exhibits slow upward recovery steps**. Both classifications are fully evidenced by the data.

---

## Concrete Match Evidence

### Example 1: Initial damage received by idle Deep

- **Timestamp**: `t = 3442 ms` (tick `1763`)
- **Trace Details**: At t=3442 ms (tick 1763), Deep was struck while standing idle (frame Ts=3 → 220). In that single tick, field `qe` fell 500 → 480 (drop of 20 HP) while field `$e` fell 500 → 494 (drop of 6 HP). Cap `Ke` remained constant at 500, and MP `je` was unaffected at 239. Over the next 1.5 seconds without further hits, `qe` climbed back slowly (480 → 484, +1 every ~400 ms) while `$e` remained completely static at 494.

### Example 2: Heavy damage impact on Deep

- **Timestamp**: `t = 4949 ms` (tick `2188`)
- **Trace Details**: At t=4949 ms (tick 2188), a heavy attack landed on Deep (frame Ts=1 → 186). Field `qe` plummeted 484 → 399 in a single tick (drop of 85 HP), while `$e` dropped 494 → 466 (drop of 28 HP). Throughout this transition, `$e` (466) remained strictly greater than or equal to `qe` (399).

### Example 3: Special move execution spending MP (Davis)

- **Timestamp**: `t = 38047 ms` (tick `10432`)
- **Trace Details**: At t=38047 ms (tick 10432), Davis initiated a special move (frame Ts=0 → 300). Field `je` fell instantly from 305 → 80 (expending 225 MP) in a single tick. Health fields remained untouched (`qe`=409, `$e`=427). Immediately after execution, `je` resumed steady regeneration at ~10 MP/second.

### Example 4: Knockout blow rendering fighter incapacitated

- **Timestamp**: `t = 30014 ms` (tick `8438`)
- **Trace Details**: At t=30014 ms (tick 8438), Deep suffered a knockout blow. Field `qe` dropped -19 → -44, crossing into negative numbers (-44). Field `$e` registered 293 → 285. For the remaining 45 seconds of the recording, Deep lay incapacitated on the ground (frame Ts=230): `qe` remained frozen at -44 and never regenerated, while `$e` remained frozen at 285.


---

## Candidate Identifiers & Team Markers

Fields that remain strictly constant throughout the entire match for each individual fighter, but have distinct values between fighters:

| Field | Deep (Slot 0) | Davis (Slot 11) | Louis (Slot 12) | Firen (Slot 13) | Deduced Meaning |
|---|---|---|---|---|---|
| `slot` | 0 | 11 | 12 | 13 | Player slot index |
| `id` | 1 | 11 | 6 | 7 | Character archetype ID (Deep=1, Davis=11, Louis=6, Firen=7) |
| `index` | 0 | 11 | 12 | 13 | Player slot index |
| `bo` | 1 | 0 | 0 | 0 | Human player / P1 controller flag (true for Deep, false for COM) |
| `ls` | 0 | 11 | 12 | 13 | Player slot index |
| `group` | 10 | 21 | 22 | 23 | Team / collision combat group (10 vs 21, 22, 23) |

---

## Candidate Facing Direction

Fields with discrete two-state values evaluated for fighter orientation:

| Field | Idle Deep Behavior | Active Fighters Behavior | Classification / Deduced Meaning |
|---|---|---|---|
| `Ps` | 0 rises, 0 falls (frozen at 0, no controller inputs) | Toggles between 0 and 1 (16–18 flips during horizontal motion) | **Input / reflex state buffer** |
| `Os` | 0 rises, 0 falls (frozen at 0, no controller inputs) | Toggles between 0 and 1 (16–18 flips during horizontal motion) | **Input / reflex state buffer** |
| `Js` | 0 rises, 0 falls (frozen at 0, no controller inputs) | Toggles between 0 and 1 (16–18 flips during horizontal motion) | **Input / reflex state buffer** |
| `Hs` | 0 rises, 0 falls (frozen at 0, no controller inputs) | Toggles between 0 and 1 (16–18 flips during horizontal motion) | **Input / reflex state buffer** |
| `He` | 0 rises, 0 falls (frozen at 0, no controller inputs) | Toggles between 0 and 1 (16–18 flips during horizontal motion) | **Input / reflex state buffer** |

*Note: Remaining two-state fields (`Qs`, `rh`, `nh`, `ce`, `Y0`, `ge`, `m3`) are internal input/combat reflex flags that remain strictly 0 on idle Deep.*
