/**
 * The game's own CPU, written down.
 *
 * Everything here was read out of `px.js` rather than guessed. `TI2f(manager,
 * fighter)` is the per-frame CPU decision, `Cr0f(...)` is its move chooser, and
 * `we(tag, n)` is the deterministic noise it uses in place of `Math.random`, so
 * a CPU plays the same fight twice. The numbers below are the thresholds those
 * functions use, which makes them the game's own definition of "level with the
 * enemy", "close enough to hit" and "time to step off the line" — a better base
 * than anything tuned by eye against a handful of runs.
 *
 * They are kept here, next to the provenance, so a re-tune is one edit and the
 * reasoning does not have to be re-derived from a minified bundle.
 */

export const BOT = {
  // --- walking to a destination (TI2f)
  // The two axes are corrected independently and each has a dead zone: the
  // sideways key stops within X_DEADZONE of the target x, the depth key within
  // Z_DEADZONE of the target z. Arriving inside ARRIVE_X/ARRIVE_Z clears the
  // destination outright, which is how the CPU stops walking rather than walking
  // through the enemy. There is no stand-off logic anywhere in it: the stop is
  // the arrival radius.
  X_DEADZONE: 6,
  Z_DEADZONE: 3,
  ARRIVE_X: 90,
  ARRIVE_Z: 90,

  // --- what "level with the enemy" means (TI2f, Cr0f)
  // A chase counts as level inside 15 of depth; a melee attack needs the tighter
  // 5. Our own Z_TOLERANCE of 12 is looser than the CPU's own attack alignment.
  ALIGN_Z: 15,
  ALIGN_Z_TIGHT: 5,

  // --- where to stand to hit without being hit (docs/07-cpu-ai.md)
  // A hit connects while the depth gap is under the attack's zwidth, 16 when
  // the data leaves it unset (px.js). The CPU starts its own attacks only
  // within ALIGN_Z_TIGHT (5) and blocks only within BLOCK_Z (9). So Jev aims
  // AIM_Z off the enemy's line: his hits land, and the CPU neither swings,
  // throws nor blocks. In the Henry v Rudolf runs, 170-300 away cost 39 hp
  // per 100 ticks on Rudolf's line and 11 when 5 or more off it.
  HIT_Z: 16,
  AIM_Z: 11,
  AIM_MIN_Z: 9,
  AIM_MAX_Z: 13,

  // --- answering a thrown weapon (TI2f dodge block)
  // A projectile inside DODGE_X of us and DODGE_Z of our depth is stepped off
  // the line; the tighter pair is used for the weapons that arrive faster.
  // Beyond DODGE_X the CPU adds distance sideways instead of stepping in depth.
  DODGE_X: 150,
  DODGE_Z: 25,
  DODGE_X_TIGHT: 80,
  DODGE_Z_TIGHT: 20,

  // --- firing bands (Cr0f)
  // A ranged move is chosen at 100..500 away and within 30 of our depth; a mid
  // move at 160; melee only inside 80 and the tight depth. The CPU fires from
  // distance and closes only when nothing reaches. This is the evidence for
  // holding at range instead of walking into the enemy.
  RANGED_MIN_X: 100,
  RANGED_MAX_X: 500,
  RANGED_Z: 30,
  MID_X: 160,
  MID_Z: 55,
  MELEE_X: 80,

  // --- blocking (TI2f)
  // The block is gated on the enemy actually being in an attack frame, being
  // level to 9, and facing us; then it holds for BLOCK_COMMIT_FRAMES and
  // re-decides. It is a parry with a cooldown, never a wall — which is why the
  // CPU is not seen standing in a guard while it is hit.
  BLOCK_Z: 9,
  BLOCK_COMMIT_FRAMES: 10,
  BLOCK_REST_FRAMES: 8,

  // --- difficulty and flinches (TI2f)
  // `J` is the CPU's difficulty and these terms scale with it. The movement
  // flinches are `1/(35+d)`: a direction key dropped for a tick now and then so
  // the walk is not a metronome. Ours uses the same shape at level 1.
  HESITATION_BASE: 35,
  HESITATION_PER_LEVEL: 20,
};

/** Where a fighter that can shoot wants to stand: just inside its firing band. */
export const STANDOFF_X = BOT.RANGED_MIN_X + 50;

/**
 * The stand-off for a fighter whose ordinary attack is a shot with a measured
 * reach: well inside that reach rather than the generic 150, where Henry,
 * whose arrow carries 450, walked in to within a few ticks of Rudolf's stars.
 */
export function standoffOf(profile) {
  if (!profile?.hasRanged) return 0;
  const reach = profile.basicAttack?.kind === 'ranged' ? profile.basicAttack.range : null;
  return reach ? Math.max(STANDOFF_X, Math.round(reach * 0.6)) : STANDOFF_X;
}

/** A run is only worth offering once walking would be slow: beyond the band. */
export const RUN_IN_MIN_X = 200;

/** Nearer than this a dash overshoots: it carries about 150 before the swing lands. */
export const DASH_MIN_GAP = 120;

/** Walking away is worth upgrading to a run inside melee range. */
export const RUN_OUT_MAX_X = BOT.MID_X;

/** The divisor of the "drop the key for a tick" flinch, as the CPU computes it. */
export const hesitation = (level = 1) => BOT.HESITATION_BASE + BOT.HESITATION_PER_LEVEL * level;

/**
 * The CPU's noise generator, copied so our flinches are deterministic too.
 * `we(tag, n)` returns a number in `[0, n)`; `0` is the branch the CPU treats as
 * "flinch now". The real one keeps a noise table and two counters and mixes
 * them, which is reproduced here.
 */
export function createNoise(seed = 1) {
  const table = new Int32Array(3000);
  let x = seed >>> 0;
  for (let i = 0; i < table.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    table[i] = x >>> 5;
  }
  let el = 0;
  let bl = 0;
  return (n) => {
    if (n <= 0) return 0;
    el = (el + 1) % 1234;
    bl = (bl + 1) % 3000;
    return (table[bl] + el) % n;
  };
}
