/**
 * Offline check of the motion reads behind the dodge and the walk:
 *   1. an enemy's held weapon swaying must not read as a projectile
 *   2. a weapon pausing mid-flight must not release the dodge early
 *   3. no attack options while the enemy is down
 *   4. no left/right tap-flip when the enemy stands on top of us
 *
 *   node scripts/check-motion.mjs
 */

import { createItemMotion } from '../src/state/arena.mjs';
import { buildOptions } from '../src/state/options.mjs';
import { planAction } from '../src/executor/actions.mjs';
import { profileFor, weapons } from '../src/lf2data/tables.mjs';

const profile = profileFor('firen');

// --- 1. carried weapon: sway next to its holder is not a projectile
const motion = createItemMotion();
const holder = { x: 100, z: 200 };
let r = '';
for (let t = 0; t < 8; t++) {
  // the weapon sits in the hand: same x as the holder, swaying ±3, dz 2
  const sway = [0, 3, 1, -2, 2, -1, 3, 0][t];
  const m = motion({ slot: 50, x: holder.x - 10 + sway, y: 0, z: holder.z + 2, range: 40 + sway },
                    [{ ...holder, x: holder.x + Math.round(sway / 2), z: holder.z }]);
  r += (m.carried ? 'C' : '.') + (m.inFlight ? 'F' : '-');
}
console.log('1) held weapon swaying:', r, '(expect C and no F)');
// a genuinely thrown weapon: leaves the holder fast
const flight = createItemMotion();
let r2 = '';
for (let t = 0; t < 8; t++) {
  const x = 100 - t * 12;
  const m = flight({ slot: 51, x, y: 0, z: 200, range: Math.abs(x - 0) },
                    [{ x: 100, z: 200 }]);
  r2 += (m.carried ? 'C' : '.') + (m.inFlight ? 'F' : '-') + (m.closing ? 'c' : '.');
}
console.log('   real throw:', r2, '(expect F and c after the first read)');

// --- 2. a weapon pausing mid-flight keeps closing (inclusive two-read test)
const pause = createItemMotion();
const seq = [144, 137, 132, 128, 123, 123, 123, 123, 120];
const closings = seq.map((range) => pause({ slot: 52, x: range, y: 0, z: 0, range }).closing);
console.log('2) closing across a mid-flight pause:', closings.map((c) => (c ? 'c' : '.')).join(''),
  '(expect no gap at the 123,123,123 stall)');

// --- 3. no attack options while the enemy is down
const me = { slot: 0, x: 0, z: 0, y: 0, facing: 'right', hp: 400, hpMax: 500, mp: 500, frame: 0, waiting: 0, alive: true, name: 'Firen', human: true };
const foeDown = { slot: 11, x: 300, z: 0, y: 0, facing: 'left', hp: 300, frame: 230, waiting: 3, alive: true, name: 'John', human: false, team: 1 };
const optsDown = buildOptions({ profile, weapons, held: null, nearest: 300, mp: 500, hp: 400, hpMax: 500,
  hasTarget: true, aligned: true, enemyDoing: 'knocked_down', canDo: () => true });
const attacks = Object.keys(optsDown).filter((k) =>
  k === 'punch' || k.startsWith('special_') || k === 'shoot' || k.endsWith('attack'));
console.log('3) attack options with the enemy down:', attacks.length ? attacks.join(',') : '(none)');

// --- 4. the tap-flip: enemy wobbling ±4 on top of us must produce no key at all
const keys = { up: 'KeyI', down: 'Comma', left: 'KeyJ', right: 'KeyL', attack: 'KeyK', jump: 'Space', defend: 'Period' };
const arena = (dx) => ({ me, threats: [{ slot: 11, x: dx, z: 0, y: 0, dx, dz: 0, gap: Math.abs(dx), zGap: 0, range: Math.abs(dx), infront: dx >= 0, aligned: true }], items: [], held: null, flying: [], nearest: Math.abs(dx) });
let flips = 0, presses = 0;
let last = null;
for (const dx of [-4, 1, -3, 2, -4, 1]) {
  const plan = planAction('close_distance', { arena: arena(dx), profile, keys });
  const h = plan.step(arena(dx));
  const now = (h.hold[0] ?? null);
  if (now && last && now !== last) flips++;
  if (now) presses++;
  last = now;
}
console.log(`4) presses across the wobble: ${presses}, direction flips: ${flips} (expect 0 and 0)`);
