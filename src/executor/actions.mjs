/**
 * Turns a chosen option into keys.
 *
 * Options come out of `src/state/options.mjs` as names Jev picked between. An
 * option the executor cannot actually carry out would quietly corrupt the
 * experiment — the answer gets recorded and the action never happens — so
 * `planAction` returns `null` for anything unsupported and the loop drops those
 * options before the question is built.
 *
 * Two kinds of action come back. A **stance** is continuous and re-evaluated
 * every tick, because walking toward a target that is itself moving is not a
 * fixed key sequence. A **burst** is a timed sequence that owns the keyboard
 * until it finishes, because a special move is four presses with gaps between
 * them and re-deciding halfway would just cancel it.
 */

import { P4_KEYS } from './keyboard.mjs';
import { DRINK_TYPE } from '../state/arena.mjs';
import { label } from '../state/options.mjs';

/** Standing on top of an item is what picks it up; the hit box is generous. */
const PICKUP_RANGE = 40;
/** LF2 only connects when attacker and target share roughly the same depth. */
const Z_TOLERANCE = 12;

/**
 * Every special move in Little Fighter starts with Defend and then adds a
 * direction and a button — the `hit_*` field names in the data files are that
 * sequence written down. `hit_Fa` is Defend, Forward, Attack. `forward` means
 * whichever way the character is facing, which is why an attack faces its
 * target before it fires.
 */
const SPECIAL_SEQUENCE = {
  a: ['attack'],
  j: ['jump'],
  d: ['defend'],
  Fa: ['forward', 'attack'],
  Ua: ['up', 'attack'],
  Da: ['down', 'attack'],
  Uj: ['up', 'jump'],
};

/** Press and gap for a special. Tuned by scripts/prove-specials.mjs. */
const SPECIAL_PRESS_MS = 60;
const SPECIAL_GAP_MS = 90;
/** A turn is a direction tap short enough not to walk anywhere much. */
const TURN_MS = 110;

export function planAction(name, { arena, profile, keys = P4_KEYS } = {}) {
  const { me, threats, items, held } = arena;
  const target = threats[0];

  if (name === 'wait') return stance(() => ({ hold: [] }));
  if (name === 'defend') {
    // Blocking only covers the side you face, so turning is part of blocking.
    return stance((a) => {
      const t = enemy(a);
      return { hold: t && !t.infront ? [keys[dirTo(a.me, t)], keys.defend] : [keys.defend] };
    });
  }

  if (name === 'close_distance') return target ? stance((a) => ({ hold: toward(a, keys, enemy(a)) })) : null;
  if (name === 'open_distance') return target ? stance((a) => ({ hold: away(a, keys, enemy(a)) })) : null;

  // plain attacks: face the target, then one tap
  if (name === 'shoot' || name === 'punch' || name.startsWith('swing_')) {
    return burst(async (kb) => {
      await face(kb, keys, me, target);
      await kb.tap(keys.attack);
    });
  }

  if (name === 'jump_attack' || name.startsWith('jump_swing_')) {
    return burst(async (kb) => {
      await face(kb, keys, me, target);
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

  // specials, and the ranged basic attack of an archer, both come from hit_*
  if (name.startsWith('special_')) {
    const move = findSpecial(profile, name);
    if (!move || !SPECIAL_SEQUENCE[move.input]) return null;
    return burst(async (kb) => {
      await face(kb, keys, me, target);
      await fireSpecial(kb, keys, move.input, dirTo(me, target ?? me));
    });
  }

  if (name === 'throw_weapon') {
    return held ? burst(async (kb) => {
      await face(kb, keys, me, target);
      await kb.tap(keys.attack);
    }) : null;
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

  return null; // anything unrecognised is not executable
}

/** The move an option name refers to, matched the way the name was built. */
const findSpecial = (profile, name) =>
  profile?.moves?.find((m) => `special_${label(m)}` === name) ?? null;

/**
 * Defend, then the rest of the sequence. Each press is short and the gaps are
 * even, because the engine reads the sequence as discrete presses inside a
 * window rather than as a held combination.
 */
async function fireSpecial(kb, keys, input, facingDir) {
  const steps = ['defend', ...SPECIAL_SEQUENCE[input]];
  for (const step of steps) {
    const code = step === 'forward' ? keys[facingDir] : keys[step];
    await kb.tap(code, SPECIAL_PRESS_MS);
    await sleep(SPECIAL_GAP_MS);
  }
}

/**
 * An attack aimed the wrong way is a wasted commitment, and a fighter that
 * never turns loses to anything that walks around it. Turning is a direction
 * tap, short enough that it does not become a walk.
 */
async function face(kb, keys, me, target) {
  if (!target || target.infront) return;
  await kb.tap(keys[dirTo(me, target)], TURN_MS);
  await sleep(TURN_MS + 40);
}

/** The nearest threat, re-read each tick because it moves and can die. */
const enemy = (arena) => arena.threats[0] ?? null;

const dirTo = (me, t) => (t && t.x >= me.x ? 'right' : 'left');

/** Walk at something, closing the depth gap too since a hit needs it. */
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
