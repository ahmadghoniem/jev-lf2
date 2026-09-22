/**
 * Offline check of the range and block options: the stand-off distance, when
 * run_in and run_out are offered, depth-only closing at the stand-off, and the
 * finite block — a run of blocks, then a rest, and nothing on a broken guard.
 *
 *   node scripts/check-options.mjs
 */

import { buildOptions } from '../src/state/options.mjs';
import { executableOptions, planAction, standoffFor } from '../src/executor/actions.mjs';
import { createReflex } from '../src/executor/reflex.mjs';
import { profileFor, weapons } from '../src/lf2data/tables.mjs';

const profile = profileFor('davis');
const me = { x: 0, z: 0, facing: 'right', mp: 500, hp: 400, hpMax: 500 };
const foe = (x, z) => ({ slot: 1, name: 'John', x, z, facing: 'left', hp: 500, frame: 0,
  dx: x, dz: z, gap: Math.abs(x), zGap: Math.abs(z), range: Math.hypot(x, z),
  side: x >= 0 ? 'right' : 'left', infront: true, aligned: Math.abs(z) <= 12,
  hasDest: false, destDx: null, destDz: null, approach: false, doing: 'none' });

const at = (x, z) => ({ me, threats: [foe(x, z)], items: [], held: null, flying: [] });
const build = (arena, over = {}) => buildOptions({
  profile, weapons, held: null, nearest: Math.abs(arena.threats[0].dx),
  mp: 500, hp: 400, hpMax: 500, hasTarget: true,
  aligned: arena.threats[0].aligned, ...over });

const far = at(350, 0);
const mid = at(120, 0);
const optsFar = build(far);
const optsMid = build(mid);
console.log('standoffFor(davis) =', standoffFor(profile));
console.log('far(350): run_in?', 'run_in' in optsFar, ' run_out?', 'run_out' in optsFar,
  ' close?', 'close_distance' in optsFar);
console.log('mid(120): run_in?', 'run_in' in optsMid, ' run_out?', 'run_out' in optsMid);

const execFar = executableOptions(optsFar, { arena: far, profile });
const execMid = executableOptions(optsMid, { arena: mid, profile });
console.log('executable far:', Object.keys(execFar).filter((k) => k.startsWith('run')).join(','));
console.log('executable mid:', Object.keys(execMid).filter((k) => k.startsWith('run')).join(','));

// The stand-off: at x=120, well inside 150, close_distance should press NO
// sideways key, only close depth.
const off = at(120, 40);
const plan = planAction('close_distance', { arena: off, profile });
let held = [];
for (let i = 0; i < 40; i++) { const h = plan.step(off); if (h.hold.length) { held = h.hold; break; } }
console.log('close_distance at x=120,z=40 holds:', held.join('|') || '(none)', '(expect only depth)');

// Dodge: a weapon on our line steps in depth, one off our line steps in x.
const onLine = at(120, 0);
onLine.flying = [{ dx: -40, dz: 8, gap: 40, zGap: 8, range: 41, eta: 3 }];
const offLine = at(120, 0);
offLine.flying = [{ dx: -40, dz: 60, gap: 40, zGap: 60, range: 72, eta: 3 }];
console.log('dodge on-line executable:', !!planAction('dodge', { arena: onLine, profile }));
console.log('dodge off-line executable:', !!planAction('dodge', { arena: offLine, profile }));

// Reflex: never blocks longer than its budget, then rests for the counter.
const reflex = createReflex();
const swing = at(60, 0);
swing.threats[0].id = 2;
swing.threats[0].frame = 91;
swing.threats[0].waiting = 0;
swing.threats[0].yGap = 0;
let blocks = 0;
const seq = [];
for (let i = 0; i < 30; i++) { const r = reflex(swing); seq.push(r?.action === 'defend' ? 'B' : '.'); if (r?.action === 'defend') blocks++; }
console.log('reflex under a held swing (B=block, .=policy):', seq.join(''));
console.log('reflex blocks over 30 ticks:', blocks, '(expect a finite run then a rest)');

// A broken guard must never block.
const broken = at(60, 0);
broken.me.id = 2;
broken.me.frame = 112;
broken.me.waiting = 0;
broken.threats[0].id = 2;
broken.threats[0].frame = 91;
broken.threats[0].waiting = 0;
broken.threats[0].yGap = 0;
console.log('reflex on a broken guard:', createReflex()(broken));
