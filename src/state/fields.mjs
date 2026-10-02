/**
 * The obfuscated field names, in one place.
 *
 * Every one of these was settled from a recorded match rather than guessed
 * (scripts/classify-fields.mjs, scripts/watch-fields.mjs). They are behind a normaliser so a
 * rebuild of the game that renames them costs one edit here and nothing else.
 */

export const F = {
  hp: 'qe',       // falls on a hit, regrows toward darkHp, negative once knocked out
  darkHp: '$e',   // the ceiling hp regrows toward; never rises
  mp: 'je',       // rises on its own, spent in chunks
  hpMax: 'Ke',    // a constant 500
  frame: 'Ts',    // current frame id
  waiting: 'waiting', // ticks elapsed in that frame
  facing: 'As',   // flips with direction of travel
  team: 'group',
  human: 'bo',
  // The guard meter, px.js `h3`: a blocked hit adds its bdefend, a clean hit
  // sets it to 45, and it falls by one a tick. A blocked hit that takes it over
  // 30 breaks the guard (frame 112).
  guard: 'h3',
  // The game's own record of the last five presses (px.js `P3`, pushed by
  // `eg` once per new press): 9 Defend, 0 Jump, 5 Attack, 8 Up, 2 Down,
  // 4 Left, 6 Right. The team shouts are read from its last four.
  keyHistory: 'P3',
};

/**
 * The game's special-move readers (px.js `sg`, `hg`, `ag`, `og`, `ng`, `rg`,
 * `lg`, `cg`, `dg`), one per combo, by their direction and last key. Each
 * holds a stage: 0 idle, 1 after Defend, 2 after the direction, 3 after the
 * last key, waiting for a frame that has the move.
 */
export const READERS = {
  Dh: 'right+attack', Vh: 'left+attack', Eh: 'up+attack', wh: 'down+attack',
  mh: 'right+jump', Sh: 'left+jump', Fh: 'up+jump', bh: 'down+jump', yh: 'jump+attack',
};

/** MP has no max field in the pool; `je` was seen at 505 while `Ke` is 500. */
export const MP_CAP = 500;

/**
 * MP refill per second at a given HP. px.js adds `1 + floor((500 - hp) / 100)`
 * per refill step, about ten steps a second: measured 10/s above 400 HP, 20/s
 * at 301-400, 30/s at 201-300. A hurt fighter refills faster.
 */
export const mpRegenPerSecond = (hp) => 10 * (1 + Math.floor((500 - Math.min(500, Math.max(0, hp))) / 100));

/** A fighter in our own vocabulary, with the raw entity kept for the log. */
export const readFighter = (e) => ({
  slot: e.slot,
  name: e.name,
  id: e.id,
  x: e.x, y: e.y, z: e.z,
  hp: e[F.hp],
  darkHp: e[F.darkHp],
  hpMax: e[F.hpMax],
  mp: e[F.mp],
  frame: e[F.frame],
  waiting: e[F.waiting],
  facing: e[F.facing] === 0 ? 'right' : 'left',
  team: e[F.team],
  human: e[F.human] === true,
  alive: e[F.hp] > 0,
  guard: e[F.guard] ?? 0,
  keyHistory: e[F.keyHistory] ?? null,
  readers: Object.fromEntries(Object.entries(READERS).map(([k, combo]) => [combo, e[k] ?? 0])),
});
