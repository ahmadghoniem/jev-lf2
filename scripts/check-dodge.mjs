/**
 * Offline check of the thrown-weapon dodge: sticky flight, the CPU's 150/25
 * trigger, the held depth step, the no-commit gate while a weapon is on our
 * lane, and depth-following suppressed while dodging. No game needed; each line
 * prints what it saw next to what is expected.
 *
 *   node scripts/check-dodge.mjs
 */

import { createItemMotion, readArena } from '../src/state/arena.mjs';
import { planAction } from '../src/executor/actions.mjs';
import { createReflex, inboundWeapon } from '../src/executor/reflex.mjs';
import { profileFor } from '../src/lf2data/tables.mjs';

const profile = profileFor('firen');

// --- 1. sticky flight: a weapon whose range oscillates stays inbound
const motion = createItemMotion();
const mk = (range) => ({ x: range, y: 0, z: 0, range });
const seq = [188, 174, 160, 150, 46, 57, 46, 54, 58, 2, 10, 54];
const flags = seq.map((r) => { const m = motion(mk(r)); return `${m.inFlight ? 'F' : '-'}${m.closing ? 'c' : '.'}`; });
console.log('sticky flight over an oscillating weapon:', flags.join(' '));
console.log('  (expect F from the first movement, c from the read after it, no F gaps)');

// --- 1b. a recycled slot: an arrow that vanished far away reappears at our
// feet. It must not read as a weapon that closed 300 in one read.
{
  const m2 = createItemMotion();
  const at = (x) => ({ slot: 52, x, y: 0, z: 0, range: Math.abs(x) });
  const rows = [at(400), at(400), at(56), at(78), at(100)].map((i) => m2(i));
  console.log('recycled slot, our arrow leaving:', rows.map((m) =>
    `${m.inFlight ? 'F' : '-'}${m.closing ? 'c' : '.'}`).join(' '));
  console.log('  (expect F from the reappearance and never c after it)');
}

// --- 2. trigger range: inbound at 150, silent at 160
const itemAt = (range, dz) => ({ name: 'weapon4', slot: 50, range, dz, zGap: Math.abs(dz),
  gap: range, dx: range, inFlight: true, closing: true, hostile: true, speed: 8 });
const withItems = (a) => ({ ...a, items: a.flying });
console.log('inboundWeapon at r150 z5 :', !!inboundWeapon(withItems({ flying: [itemAt(150, 5)] })));
console.log('inboundWeapon at r160 z5 :', inboundWeapon(withItems({ flying: [itemAt(160, 5)] })));
console.log('inboundWeapon at r150 z30:', inboundWeapon(withItems({ flying: [itemAt(150, 30)] })));

// --- 3. the dodge is a stance that holds until separation clears
const me = { slot: 0, x: 0, z: 0, y: 0, facing: 'right', hp: 400, hpMax: 500, mp: 500, frame: 0, waiting: 0, alive: true, name: 'Firen', human: true };
const foe = { slot: 11, x: -300, z: 0, y: 0, facing: 'left', hp: 500, frame: 0, waiting: 0, alive: true, name: 'John', human: false, team: 1 };
const arenaAt = (weaponRange, weaponDz) => ({ me,
  threats: [{ ...foe, x: -300, z: 30, dx: -300, dz: 30, gap: 300, zGap: 30, range: 300, infront: false, aligned: false }],
  items: weaponRange === null ? [] : [itemAt(weaponRange, weaponDz)], held: null,
  flying: weaponRange === null ? [] : [itemAt(weaponRange, weaponDz)], nearest: 300 });
const plan = planAction('dodge', { arena: arenaAt(120, 5), profile });
let held = [];
for (let step = 0; step < 30; step++) {
  // simulate our z moving away from the weapon by 4 per tick while it holds
  const dz = 5 - step * 4;
  const h = plan.step(arenaAt(120, dz));
  if (!h.hold.length) { console.log(`dodge stance released after ${step} ticks (dz now ${dz}); last hold: [${held.join(',')}]`); break; }
  held = h.hold;
}
console.log('dodge direction with weapon below (dz=-5):', plan.step(arenaAt(120, -5)).hold.join(','), '(expect down)');

// --- 4. no attack commits while a weapon is inbound on our lane
for (const [r, expect] of [[120, 'refused'], [200, 'allowed']]) {
  const a = arenaAt(r, 5);
  const out = ['special_ball1', 'punch', 'run_attack', 'rush_attack']
    .filter((n) => planAction(n, { arena: a, profile }) === null);
  console.log(`attacks with a weapon at r=${r}: ${out.length ? out.join(',') + ' refused' : 'none refused'} (expect ${expect})`);
}
console.log('dodge still executable with a weapon at r=120:', !!planAction('dodge', { arena: arenaAt(120, 5), profile }));
console.log('close_distance executable with a weapon at r=120:', !!planAction('close_distance', { arena: arenaAt(120, 5), profile }));

// --- 5. close_distance suppresses depth while a weapon is on the lane
// The enemy is 30 deep of us, so a clean lane would hold a depth key.
const closing = planAction('close_distance', { arena: arenaAt(120, 5), profile });
const clean = planAction('close_distance', { arena: arenaAt(null), profile });
const cleanHold = [];
for (let i = 0; i < 20; i++) { const h = clean.step(arenaAt(null)); if (h.hold.length) { cleanHold.push(...h.hold); break; } }
const wHold = [];
for (let i = 0; i < 20; i++) { const h = closing.step(arenaAt(120, 5)); if (h.hold.length) { wHold.push(...h.hold); break; } }
console.log('close_distance holds with a clean lane:', cleanHold.join(',') || '(none)', '(expect x + depth)');
console.log('close_distance holds with a weapon inbound:', wHold.join(',') || '(none)', '(expect x only, no depth)');
