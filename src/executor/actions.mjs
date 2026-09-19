/**
 * Turns a chosen option into keys.
 *
 * Options come out of `src/state/options.mjs` as names Jev picked between. Not
 * all of them can be carried out yet — the special moves need `hit_*` input
 * strings that are still unconfirmed — and offering an option the executor
 * cannot perform would quietly corrupt the experiment. So `planAction` returns
 * `null` for anything it cannot do, and the loop drops those options before the
 * question is ever built.
 *
 * Two kinds of action come back. A **stance** is continuous and re-evaluated
 * every tick, because walking toward a moving target is not a fixed key
 * sequence. A **burst** is a timed sequence that owns the keyboard until it
 * finishes, because a dash attack is three presses with gaps between them.
 */

import { P4_KEYS } from './keyboard.mjs';
import { DRINK_TYPE } from '../state/arena.mjs';

/** Standing on top of an item is what picks it up; the hit box is generous. */
const PICKUP_RANGE = 40;
/** LF2 only connects when attacker and target share roughly the same depth. */
const Z_TOLERANCE = 12;

export function planAction(name, { arena, keys = P4_KEYS }) {
  const { me, threats, items, held } = arena;
  const target = threats[0];

  if (name === 'wait') return stance(() => ({ hold: [] }));
  if (name === 'defend') return stance(() => ({ hold: [keys.defend] }));

  if (name === 'close_distance') return target ? stance((a) => ({ hold: toward(a, keys, enemy(a)) })) : null;
  if (name === 'open_distance') return target ? stance((a) => ({ hold: away(a, keys, enemy(a)) })) : null;

  // plain attacks: one tap, and for an archer that tap is the shot
  if (name === 'shoot' || name === 'punch' || name.startsWith('swing_')) {
    return burst(async (kb) => { await kb.tap(keys.attack); });
  }

  if (name === 'jump_attack' || name.startsWith('jump_swing_')) {
    return burst(async (kb) => {
      await kb.tap(keys.jump);
      await sleep(220);
      await kb.tap(keys.attack);
    });
  }

  if (name === 'run_attack' || name.startsWith('run_swing_')) {
    return target ? burst(async (kb) => {
      const dir = keys[dirTo(me, target)];
      await kb.doubleTap(dir);
      await sleep(280);
      await kb.tap(keys.attack);
      await sleep(120);
      await kb.hold([]);
    }) : null;
  }

  if (name === 'dash_attack' || name.startsWith('dash_swing_')) {
    return target ? burst(async (kb) => {
      const dir = keys[dirTo(me, target)];
      await kb.doubleTap(dir);
      await sleep(90);
      await kb.tap(keys.jump);
      await sleep(160);
      await kb.tap(keys.attack);
      await sleep(120);
      await kb.hold([]);
    }) : null;
  }

  if (name === 'throw_weapon') {
    return held ? burst(async (kb) => { await kb.tap(keys.attack); }) : null;
  }
  if (name === 'drop_weapon') {
    return held ? burst(async (kb) => {
      await kb.tap(keys.defend);
      await sleep(80);
      await kb.tap(keys.attack);
    }) : null;
  }

  // go and get something: walk to it, then press attack on top of it
  if (name.startsWith('pick_up_') || name.startsWith('drink_')) {
    const wantDrink = name.startsWith('drink_');
    const pick = (a) => a.items.find((i) => (i.type === DRINK_TYPE) === wantDrink) ?? null;
    if (!pick(arena)) return null;
    return stance((a) => {
      const item = pick(a);
      if (!item) return { hold: [] };
      if (item.range <= PICKUP_RANGE) return { hold: [], tap: [keys.attack] };
      return { hold: toward(a, keys, item) };
    });
  }

  return null; // specials and anything unrecognised: not executable yet
}

/** The nearest threat, re-read each tick because it moves and can die. */
const enemy = (arena) => arena.threats[0] ?? null;

const dirTo = (me, t) => (t.x >= me.x ? 'right' : 'left');

/** Walk at something, closing the depth gap first since a hit needs it. */
function toward(arena, keys, t) {
  if (!t) return [];
  const out = [keys[dirTo(arena.me, t)]];
  const dz = t.z - arena.me.z;
  if (dz < -Z_TOLERANCE) out.push(keys.up);
  if (dz > Z_TOLERANCE) out.push(keys.down);
  return out;
}

function away(arena, keys, t) {
  if (!t) return [];
  return [keys[dirTo(arena.me, t) === 'right' ? 'left' : 'right']];
}

const stance = (step) => ({ kind: 'stance', step });
const burst = (run) => ({ kind: 'burst', run });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which of the offered options the executor can actually carry out. */
export function executableOptions(options, ctx) {
  const out = {};
  for (const [name, description] of Object.entries(options)) {
    if (planAction(name, ctx)) out[name] = description;
  }
  return out;
}
