/**
 * The obfuscated field names, in one place.
 *
 * Every one of these was settled from a recorded match rather than guessed —
 * the evidence is in docs/05-live-state.md. They are behind a normaliser so a
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
};

/** MP has no max field in the pool; `je` was seen at 505 while `Ke` is 500. */
export const MP_CAP = 500;

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
});
