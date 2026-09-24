# The game's CPU player

Read out of `px.js` (the Remastered bundle, 1,032,835 bytes). Four functions
make the whole CPU:

| Function | Offset | Role |
|---|---|---|
| `TI2f(e, t)` | 702570 | per-tick decision for fighter `t`: target, movement, block, jump, plain attack |
| `Cr0f(...)` | 718387 | per-character special moves, one block per character id |
| `UZAk(...)` | — | the generic "Defend, then direction + Attack" input (the D>A special) and the plain melee swing |
| `JoYQ(...)` | — | what to do while holding a weapon or a drink |

`e.we(tag, n)` is the CPU's dice: a counter-based table lookup, `(table[i] +
j) % n`, and `we(tag, 0)` is always 0. It is called once per condition per
tick, so "`0 == we(k, 10)`" is a 1-in-10 chance **every tick**, about three
times a second at 30 ticks a second.

Field names: `qe` hp, `je` MP, `As` facing (0 right, 1 left), `Cs` x speed,
`Ts` frame, `x`/`z` position. Keys: `left`, `right`, `ce` up, `Y0` down,
`attack`, `ge` jump, `Ks` defend. A move flag set to 3 (`mh`, `Sh`, `Dh`, ...)
is played as that input on the next frame that allows it. The flags map to
the frame fields the game's loader fills from `hit_*`:

| Flag | Frame field | Input |
|---|---|---|
| `Dh`/`Vh` | `Is` | D>A (`hit_Fa`), facing right/left |
| `mh`/`Sh` | `En` | D>J (`hit_Fj`), facing right/left |
| `Eh` | `Sn` | D^A (`hit_Ua`) |
| `wh` | `bn` | DvA (`hit_Da`) |
| `Fh` | `Fn` | D^J (`hit_Uj`) |
| `bh` | `wn` | DvJ (`hit_Dj`) |
| `yh` | `yn` | DJA (`hit_ja`) |

## Difficulty

`J = e.Ie` (the menu cycles it 0-2), clamped at 0, and every chance is scaled by it: `we(k, base +
c*J)`. The menu stores Easy 2, Normal 1, **Difficult 0**, Crazy -1. So
**Difficult and Crazy play identically** in these functions: every scaled
term is 0, and the rarest reactions become certainties. At Difficult:

- `Cr0f` runs every tick (its gate is `we(60, 7J+1)`).
- A thrown energy ball is always answered (below).

## Choosing a target

The nearest living enemy by `|dx| + |dz|`, skipping one that is lying down
(state 14) or blinking after getting up. The previous target is kept with a
29-in-30 chance per tick, so it rarely switches.

An enemy ball in flight (state 3000) heading at the CPU counts as a target
too, and it wins whenever it is nearer than the fighter who threw it.

## What it does, in order, each tick

1. **A ball heading at it within 200** (state 3000, moving toward it, no
   depth check): press Defend and face the ball, and nothing else that tick.
   At Difficult the chance is 1 in 1, so every ball that comes within 200 of
   a free CPU is blocked. Ball objects with state 3000: Davis's, Firen's,
   Deep's, Dennis's, Woody's, Freeze's, John's, Jack's, Firzen's, Julian's
   and Justin's. **Henry's arrows are not** (states 1000s and 3006), and nor
   are thrown weapons such as Rudolf's stars.
2. **An enemy lying down or blinking**: walk *away* from it in x (unless
   near a wall) and step off its line in depth. The CPU never attacks a
   fighter on the floor. This is why Jev lying down was never hit.
3. **A weapon or drink on the floor** nearer than twice the enemy's distance,
   while the enemy is not already on its line: walk over and pick it up.
4. **Special moves** (`Cr0f`, per character, below). If one fires, stop.
5. **Walk to the target.**
   - Henry, Rudolf and Hunter keep range: they walk in only while more than
     170 away (150 when facing), and stop there.
   - Everyone else walks in until within 60.
   - Depth: step to within 3 of the target's line.
6. **Block**: 1 in 10 per tick, when the target is in an attack frame
   (state 3 or 3xx), within 9 of depth, and facing the CPU.
7. **Random jump**: about 1 in 44 per tick (`we(31,20)<3 && we(32,20)<3`).
8. **Plain attack**:
   - Melee characters: 1 in 3 per tick when the target, allowing for the
     CPU's own speed, is within 80 in x **and within 5 in depth**.
   - Henry and Rudolf: when the target is within 100 x and 80 depth, 1 in 2
     per tick they **run away** toward the side with more room (and jump 1 in
     17). Otherwise 1 in 3 per tick they shoot or throw when the target is
     within 350 (Henry) / 300 (Rudolf) **and within 5 in depth**, facing it.
   - A dizzy target (state 16) is walked into and grabbed by everyone.
9. **The D>A special** (`UZAk`), for John, Henry, Louis, Dennis, Woody,
   Davis, Freeze, Firen, Jack and Sorcerer: 1 in 10 per tick, press Defend
   when the target is 100-900 away and **within 5 in depth**; then, on the
   defend frame, press toward the target with Attack. This is Firen's and
   Davis's ball.

The CPU steps out of the way of only three things: John's ball (id 200,
frames 50-69), Firen's ground flame (id 211, state 18) and Freeze's column
(id 212, frames 150-170). The `DODGE_*` box in `src/state/bot.mjs` is that
code; it does not apply to other projectiles.

**Depth 5 is the CPU's line.** Every plain attack, every thrown star and the
D>A ball need the target within 5 of depth. Its blocks need 9.

## Specials by character (Cr0f), at Difficult

Chances are per tick. "Facing" means the CPU faces the target.

**Rudolf (5)**
- MP > 450, more than 100 away and more than 50 off the line, 1 in 3: vanish
  (D^J, 250) or clone (DvJ, 260), half each.
- MP > 70, 100-160 away, within 8 of depth, 1 in 10: Leap Attack (D>J, 273).
- MP > 200, 100-160 away, within 55 of depth, facing, 1 in 30: multiple
  stars (D>A, 285).

**Firen (7)**
- HP over 70 and more than the target's, MP > 320, within 85 in x and 35 in
  depth, but not both within 50 x and 10 depth, 1 in 5: explosion (D^J, 285).
- MP > 200, 100-370 away, within 60 of depth, 1 in 20 (or 1 in 100 at
  240-400): burning run (D>J, 255). It stops the run once 120 past the
  target, near a wall, or more than 70 off its line.
- MP > 200, 60-280 away, within 60 of depth, facing, 1 in 15: flame (DvJ, 267).
- Fireball: the generic D>A above.

**Henry (4)**
- MP > 360, within 100 x and 70 depth, 1 in (HP/5 + 10): flute (D^J, 250).
- MP > 170, 100-550 away, within 20 of depth, 1 in 45: super arrow (D>J, 270).
- MP > 200, 100-160 away, within 55 of depth, facing, 1 in 30: DJA (280,
  five arrows).

**Davis (11)**
- MP > 150, within 280 x and 30 depth, facing, 1 in 10: many punch (DvA,
  270), but only when the target is to its right (the code sets the flag only
  on that side).
- MP > 200, within 100 x (allowing for speed) and 7 depth, facing, 1 in 5
  (always, against a dizzy or broken-guard target): dragon punch (D^A, 300).

## Weapons and drinks (JoYQ)

- With a drink (milk or beer) at Difficult the CPU does not drink at once. It
  runs to the far side of the stage from the enemy, jumping now and then, and
  drinks there. At Easy and Normal it drinks where it stands.
- A light weapon is swung within 115 x and 6 depth, 1 in 3; thrown at range
  sometimes.

## Checked against the runs (2026-09-24, 15 games)

Rates from our logs, the enemy's next 5 ticks while it was free to act:

| Enemy, distance | Depth under 5 | Depth 5 or more |
|---|---|---|
| Firen within 100: attacks | 59% | 16% |
| Rudolf 100-170: attacks | 22% | 5% |
| Rudolf within 100: moves away / runs | 49% / 23% | 30% / 10% |

Davis's ball against Firen (34 balls): of 6 thrown while Firen was free to
act, Firen was seen blocking after 4. The sample is small.

## What this means for Jev

- **Stand 5 or more off the enemy's line.** Every CPU attack needs 5 or
  less. Our logs show a 3-4 times lower attack rate there. The old line
  question used 30, which costs far more walking than needed.
- **Fire balls only at a CPU that is busy** (attacking, hit, in the air,
  landing). A free CPU blocks every ball within 200, whatever its depth.
  Henry's arrows are not covered by this rule.
- **Rudolf and Henry run from anyone within 100.** Chasing them in costs time.
  A melee chase works only against a cornered one.
- **Nothing hits a fighter on the floor.** Lying down is safe.
- **A CPU with a drink runs away to drink.** Drinking is a locked window;
  chase it.
