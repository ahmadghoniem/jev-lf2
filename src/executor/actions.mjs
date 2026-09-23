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

import { setTimeout as sleep } from 'node:timers/promises';
import { P4_KEYS } from './keyboard.mjs';
import { DRINK_TYPE, Z_TOLERANCE, isDown, doing } from '../state/arena.mjs';
import { REACH_SLACK } from '../lf2data/frames.mjs';
import { label } from '../state/options.mjs';
import { incoming, inboundWeapon } from './reflex.mjs';
import { BOT, STANDOFF_X, createNoise, hesitation } from '../state/bot.mjs';

/** Standing on top of an item is what picks it up; the hit box is generous. */
const PICKUP_RANGE = 40;

/**
 * The `hit_*` field names in the data files are the key sequence written down.
 * An uppercase direction is a Defend-prefixed special — `hit_Fa` is Defend,
 * Forward, Attack — while a lowercase letter is a plain button press from the
 * frame (`hit_a` is just Attack). `forward` means whichever way the character
 * is facing, which is why an attack faces its target before it fires.
 *
 * The Defend prefix lives in this table rather than being added by the caller,
 * because adding it to a lowercase input sends Defend+Attack and the move never
 * starts.
 */
const SPECIAL_SEQUENCE = {
  a: ['attack'],
  j: ['jump'],
  d: ['defend'],
  Fa: ['defend', 'forward', 'attack'],
  Ua: ['defend', 'up', 'attack'],
  Da: ['defend', 'down', 'attack'],
  Uj: ['defend', 'up', 'jump'],
  Fj: ['defend', 'forward', 'jump'],
  Dj: ['defend', 'down', 'jump'],
  ja: ['defend', 'jump', 'attack'],
};

/** How long a turn is: a direction tap short enough not to walk anywhere. */
const TURN_MS = 110;
/** How long a run burst keeps holding the direction after the double-tap. */
const RUN_MS = 520;
/**
 * Ticks from pressing the double-tap to the first frame with no hurt box: the
 * 60 ms tap, the 60 ms gap and the run before Defend, about 320 ms, with a
 * margin. A weapon arriving sooner than this lands during the run.
 */
export const ROLL_START_TICKS = 12;
/** Every standard fighter rolls on frames 102-107 with no hurt box. */
const hasRoll = (profile) => profile?.canRoll !== false;
/**
 * The CPU flinches: it drops a movement key for a tick now and then so its walk
 * is not a metronome. Copied at the CPU's own rate, and deterministic so a run
 * is still reproducible.
 */
const moveNoise = createNoise(7);

/**
 * Where this fighter should stop closing.
 *
 * A fighter that can fire holds at its firing band — but only while it has the
 * MP to actually fire. A stand-off is a position to shoot from; with an empty
 * bar it is just a place to stand useless in, and the run data shows the cost:
 * 30 of 32 close_distance ticks inside melee reach were spent standing still,
 * taking 52 hp. So the hold applies only when the cheapest ranged move is
 * affordable; below that the stand-off is zero and this walks all the way in.
 */
export const standoffFor = (profile, mp = Infinity) =>
  (profile?.hasRanged && mp >= (profile.cheapestRangedMp ?? 0) ? STANDOFF_X : 0);

/** How far a bare-handed hit reaches, for deciding when to press attack. */
const meleeReach = (profile) => profile?.bestMelee?.reach ?? profile?.basicAttack?.reach ?? 45;

/**
 * A committed attack that waits until it is worth firing.
 *
 * The old bursts pressed the sequence the moment they started, and the lane data
 * shows what that bought: 61% of the ball casts in one run were fired with the
 * enemy more than 12 units off our depth — up to 78 — every one of them a
 * missed ball and a wasted 75 MP, because the ball travels along our lane and
 * nowhere else. So the attack is a stance: hold depth until the target is in
 * the lane, turn to face, and only then play the sequence, one press every few
 * ticks so the presses stay distinct the way the tuned gap produced them.
 *
 * As a stance it re-reads the arena every tick, so an enemy that walks out of
 * the lane during the wind-up is chased before the sequence ever starts, which
 * a fixed burst frozen at plan time could not do.
 */
function aimedAttack(keys, { tight, seq = ['attack'], needReach = false, reach = 45, spendsMp = false }) {
  let step = 0;
  const started = () => step > 0 && step < seq.length * 5;
  const run = (a) => {
    const t = enemy(a);
    if (!t) return { hold: [] };
    // Presses made while staggered or knocked about are read by nobody, and a
    // hit mid-sequence leaves it half played. In one run 38 of 40 blastpush
    // attempts ended this way: Henry pressed Defend (a block pose on screen),
    // got hit, and started over. So the sequence starts only from a stance
    // that can act, and a hit restarts it.
    const mine = doing(a.me);
    if (HURT.has(mine)) {
      if (started()) step = 0;
      return { hold: [] };
    }
    if (step === 0 && !CAN_START.has(mine)) return { hold: [] };
    // Off the screen nothing lands, so walk on until it is back in view.
    if (t.onScreen === false) {
      if (started()) step = 0;
      return { hold: toward(a, keys, t) };
    }
    // An enemy that goes down while the sequence is being played would take
    // the MP and nothing else — the observer saw blastpush fired into a
    // falling Rudolf — so the last press waits until it is up again.
    if (spendsMp && isDown(t.doing)) {
      if (started()) step = 0;
      return { hold: [] };
    }
    const dz = t.z - a.me.z;
    // Losing the lane mid-sequence restarts it: a half-played sequence (guard
    // and forward pressed, attack not) is neither a move nor a safe state to
    // resume from. A completed sequence is not restarted — that would be a
    // second cast paid for by the same answer.
    if (Math.abs(dz) > tight) {
      if (step > 0 && step < seq.length * 5) step = 0;
      return { hold: [dz < 0 ? keys.up : keys.down] };
    }
    if (needReach && !started() && t.gap > reach + REACH_SLACK) return { hold: toward(a, keys, t) };
    if (!t.infront) return { hold: [], tap: [keys[dirTo(a.me, t)]] };
    // One press every fifth tick: ~166 ms between press starts, which keeps
    // the presses distinct the way the 60 ms press + 90 ms gap tuned by
    // scripts/prove-specials.mjs did.
    if (step < seq.length * 5) {
      if (step % 5 === 0) {
        const press = seq[step / 5];
        const code = press === 'forward' ? keys[dirTo(a.me, t)] : keys[press];
        step++;
        return { hold: [], tap: [code], special: seq.length > 1 };
      }
      step++;
      return { hold: [] };
    }
    return { hold: [] };
  };
  // A half-played sequence, which a repeat of the same answer should not restart.
  run.busy = started;
  return run;
}
/** States a hit leaves a fighter in, where key presses do nothing. */
const HURT = new Set(['staggered', 'broken_guard', 'knocked_down', 'in_the_air']);
/** What an attack sequence can start from; a block counts, since specials open with Defend. */
const CAN_START = new Set(['neutral', 'walking', 'running', 'blocking']);

export function planAction(name, { arena, profile, keys = P4_KEYS } = {}) {
  const { me, threats, held } = arena;
  const target = threats[0];

  if (name === 'wait') return stance(() => ({ hold: [] }));
  if (name === 'defend') {
    // Blocking only covers the side you face, so turning is part of blocking.
    // It lasts only while something is coming, by the same test that offers
    // the option: held until the next decision, a block against a star went on
    // 0.5-1 s after the star had passed, which read as blocking at nothing.
    return stance((a) => {
      const t = enemy(a);
      const weapon = inboundWeapon(a);
      const coming = incoming(a, { within: 12 }) || weapon || (t && t.gap <= 100);
      if (!coming) return { hold: [] };
      // Face what is arriving: a weapon thrown from the other side is blocked
      // only by turning to it.
      const side = weapon ? (weapon.dx >= 0 ? 'right' : 'left') : t ? dirTo(a.me, t) : a.me.facing;
      return { hold: side !== a.me.facing ? [keys[side], keys.defend] : [keys.defend] };
    });
  }

  // Closing is range-relative, not "walk at the enemy until you are touching
  // it". A fighter that can shoot stops at its firing band and only corrects
  // depth from there, which is how the game's own CPU fights: it answers the
  // lane question without walking into the melee.
  if (name === 'close_distance') {
    if (!target) return null;
    return stance((a) => {
      const t = enemy(a);
      if (!t) return { hold: [] };
      // While a weapon is inbound through our lane, depth is not corrected: the
      // enemy's projectile travels along the enemy's lane, so aligning with the
      // enemy is walking into its fire. The CPU suppresses lane-following while
      // a projectile is inbound for exactly this reason. The dodge stance owns
      // depth until the lane is clear; this holds only the sideways keys.
      const w = weaponOnLane(a);
      const stopAt = standoffFor(profile, a.me.mp);
      let hold = toward(a, keys, t, { stopAt, noDepth: !!w });
      // The walk flinch, copied from the CPU: a direction key dropped for a
      // tick now and then, so the approach is not a metronome.
      if (moveNoise(hesitation(1)) === 0) hold = [];
      // Facing is not free: it only changes with a direction press, and a
      // stance that has stopped walking — at the stand-off, or on a flinch
      // tick — never presses one, so Jev keeps whatever facing he had, often
      // with his back to the enemy. A short tap toward the enemy turns him
      // where he stands without walking anywhere measurable.
      if (!hold.length && !t.infront) return { hold: [], tap: [keys[dirTo(a.me, t)]] };
      return { hold };
    });
  }
  if (name === 'open_distance') {
    if (!target) return null;
    return stance((a) => {
      const t = enemy(a);
      if (!t) return { hold: [] };
      if (moveNoise(hesitation(1)) === 0) return { hold: [] };
      return { hold: away(a, keys, t) };
    });
  }

  // Walking is precise and running covers ground; the game only reads a run from
  // a double-tap, so the same direction has to be given twice. A burst, because
  // a re-decision halfway would cancel the run.
  // A roll is the one move with no hurt box: frames 102-107, reached by
  // pressing Defend while running. Measured on Henry: about 450 ms and 190
  // units of travel with nothing to hit. It goes away from the enemy.
  // A stance, not a fixed burst, because each step depends on what the fighter
  // is doing. As a blind burst it fired from the floor: the double-tap was lost
  // while Henry was knocked down, and the Defend press that should have turned
  // a run into a roll became a block facing away from the enemy.
  if (name === 'roll_away') {
    if (!target || !hasRoll(profile)) return null;
    return stance(rollAway(keys));
  }

  if (name === 'run_in' || name === 'run_out') {
    if (!target) return null;
    const dir = name === 'run_out'
      ? (dirTo(me, target) === 'right' ? 'left' : 'right')
      : dirTo(me, target);
    return burst(async (kb) => {
      await kb.doubleTap(keys[dir]);
      await sleep(RUN_MS);
      await kb.hold([]);
    });
  }

  // Stepping off the line a thrown weapon travels along, and staying off it.
  // This is a stance rather than a fixed burst: the weapon is already in the
  // air, its arrival time is only ever an estimate, and the run data shows a
  // 180 ms step gained 5-7 units of separation where 25 were needed. So the
  // step is held until the lane is actually clear — either the weapon has
  // passed far enough in depth, or it is gone from the air entirely.
  if (name === 'dodge') {
    if (!weaponOnLane(arena)) return null;
    return stance((a) => {
      const item = weaponOnLane(a);
      if (!item) return { hold: [] };
      if (Math.abs(item.dz) >= BOT.DODGE_Z) return { hold: [] };
      // `up` decreases z, so if the weapon sits above us in depth, stepping up
      // widens the gap. Same one tick later for the other side.
      // Always the step, never the jump. A jump for a weapon a few ticks out
      // looked faster on paper, but Rudolf's shuriken hits an airborne body: in
      // three runs, 45 of 65 jump dodges were hit within 25 ticks against 34 of
      // 77 depth steps, and several jumps cut short a step that would have
      // cleared the lane.
      return { hold: [item.dz > 0 ? keys.up : keys.down] };
    });
  }

  // The decision that chose this move was made ~350 ms ago, so the enemy may
  // have gone down since. Nothing refunds MP, so re-check at the moment of
  // firing: an MP-costing move is not spent on a target that cannot be hit.
  if (target && isDown(target.doing) && mpCost(profile, name) > 0) {
    return stance(() => ({ hold: [] }));
  }

  // No attack starts while a weapon is already on its way through our lane:
  // the dodge owns that lane until it is clear, and an attack started now would
  // still be in its recovery when the weapon arrives.
  if (isAttackOption(name) && weaponOnLane(arena)) return null;

  // plain attacks: line up in the lane, face the target, then one tap. A melee
  // hit needs the CPU's tight 5 of depth; a fired shot is fine within the
  // looser 12. The punch only taps when the target is inside its reach, so it
  // stops whiffing from out of range.
  if (name === 'shoot' || name === 'punch' || name.startsWith('swing_')) {
    const melee = name !== 'shoot';
    return stance(aimedAttack(keys, { tight: melee ? BOT.ALIGN_Z_TIGHT : Z_TOLERANCE,
                                       needReach: melee, reach: meleeReach(profile) }));
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
    // A projectile that weakens with distance fires only inside its full-damage
    // band. The answer is chosen against where the enemy was half a second ago;
    // in one run Rudolf had backed off to 280 by the time Henry pressed, and two
    // 150-MP blastpushes did 13 and 7.
    const fullBand = move.falloff?.[0]?.to;
    return stance(aimedAttack(keys, { tight: Z_TOLERANCE, seq: SPECIAL_SEQUENCE[move.input],
                                      spendsMp: (move.mp ?? 0) > 0,
                                      needReach: !!fullBand, reach: (fullBand ?? 0) - REACH_SLACK }));
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

  // punish a helpless enemy: close the distance, then hit once in range
  if (name === 'rush_attack') {
    if (!target) return null;
    const reach = meleeReach(profile);
    return stance((a) => {
      const t = enemy(a);
      if (!t) return { hold: [] };
      if (t.gap <= reach + REACH_SLACK && t.zGap <= Z_TOLERANCE) return { hold: [], tap: [keys.attack] };
      return { hold: toward(a, keys, t) };
    });
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

/**
 * The roll, one tick at a time: wait until the fighter can act, double-tap away
 * from the enemy, hold the run until the game shows running, then Defend.
 * A run that never starts within the budget gives up rather than pressing
 * Defend into a standing block.
 */
function rollAway(keys) {
  let phase = 'ready';
  let dir = null;
  let ticks = 0;
  return (a) => {
    const t = enemy(a);
    const now = doing(a.me);
    ticks++;
    if (phase === 'ready') {
      if (!t || !ACTIONABLE.has(now)) return { hold: [] };
      dir = dirTo(a.me, t) === 'right' ? 'left' : 'right';
      phase = 'tap'; ticks = 0;
    }
    // The double-tap as holds, about the 60 ms press and 60 ms gap that
    // `kb.doubleTap` uses: two ticks down (the first is the tick that chose the direction), one up,
    // then held into the run.
    if (phase === 'tap') {
      if (ticks <= 1) return { hold: [keys[dir]] };
      if (ticks === 2) return { hold: [] };
      phase = 'run'; ticks = 0;
      return { hold: [keys[dir]] };
    }
    if (phase === 'run') {
      if (now === 'running') { phase = 'roll'; ticks = 0; return { hold: [], tap: [keys.defend], special: true }; }
      if (ticks > RUN_START_TICKS) { phase = 'done'; return { hold: [] }; }
      return { hold: [keys[dir]] };
    }
    return { hold: [] };
  };
}
/** What a fighter can start a run from. */
const ACTIONABLE = new Set(['neutral', 'walking', 'running']);
/** Reads it takes the game to show a run after the double-tap (about 4 measured), with margin. */
const RUN_START_TICKS = 10;

/** The MP a named option costs, or 0 for the free moves. */
function mpCost(profile, name) {
  if (name === 'shoot') return profile?.basicAttack?.mp ?? 0;
  if (name.startsWith('special_')) return findSpecial(profile, name)?.mp ?? 0;
  return profile?.moves?.find((m) => label(m) === name)?.mp ?? 0;
}

/** The move an option name refers to, matched the way the name was built. */
const findSpecial = (profile, name) =>
  profile?.moves?.find((m) => `special_${label(m)}` === name) ?? null;

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

/**
 * Walk at something, correcting depth as well as distance. A target that is
 * level in `x` but a long way off in `z` is the common case for an item lying
 * just above or below us, and pressing a sideways key at it only walks past —
 * so the sideways key is dropped once the horizontal gap is closed and the
 * depth keys do the rest.
 *
 * `stopAt` is the range to hold: past it the sideways key is dropped even
 * though the gap is still real, which is what keeps a ranged fighter from
 * walking into the melee. Depth is still corrected, because depth is what makes
 * a fired move connect. The depth dead zone is the CPU's own 3 rather than the
 * looser `Z_TOLERANCE`, since lining up is free and a missed shot is not.
 */
function toward(arena, keys, t, { stopAt = 0, xDead = BOT.X_DEADZONE, zDead = BOT.Z_DEADZONE,
                             noDepth = false } = {}) {
  if (!t) return [];
  const out = [];
  const dx = t.x - arena.me.x;
  const dz = t.z - arena.me.z;
  // The x dead zone is the CPU's own 6, not the tighter depth one. At 3 the key
  // flickered on and off — and flipped sides — as dx wobbled ±4 around zero with
  // the enemy standing on top of us, which read as the fighter tapping left and
  // right in place.
  if (Math.abs(dx) > xDead && Math.abs(dx) > stopAt) out.push(keys[dx >= 0 ? 'right' : 'left']);
  if (!noDepth) {
    if (dz < -zDead) out.push(keys.up);
    if (dz > zDead) out.push(keys.down);
  }
  return out;
}

/**
 * A weapon that is going to pass through our lane: in the air, close enough to
 * arrive before anything we start would finish, and within the CPU's own dodge
 * depth. This is the gate for committing to an attack, because an attack cannot
 * be cancelled once it starts and a weapon that is already on its way will be
 * here first. The run data has the exact cost: a ball fired into an incoming
 * weapon put us in recovery, and the weapon landed while we could neither block
 * nor step — 45 hp, taken staggered.
 */
const weaponOnLane = (arena) =>
  (arena.items ?? []).find((i) => i.hostile
    && i.zGap <= BOT.DODGE_Z && i.range <= BOT.DODGE_X) ?? null;

/** Options that press attack and cannot be cancelled once started. */
export const isAttackOption = (name) => name === 'shoot' || name === 'punch'
  || name.startsWith('swing_') || name.startsWith('jump_swing_') || name === 'jump_attack'
  || name.startsWith('run_swing_') || name === 'run_attack'
  || name.startsWith('dash_swing_') || name === 'dash_attack'
  || name.startsWith('special_') || name === 'throw_weapon' || name === 'rush_attack';

function away(arena, keys, t) {
  if (!t) return [];
  return [keys[dirTo(arena.me, t) === 'right' ? 'left' : 'right']];
}

const stance = (step) => ({ kind: 'stance', step, busy: step.busy ?? (() => false) });
const burst = (run) => ({ kind: 'burst', run });

/** Which of the offered options the executor can actually carry out. */
export function executableOptions(options, ctx) {
  const out = {};
  for (const [name, description] of Object.entries(options)) {
    if (planAction(name, ctx)) out[name] = description;
  }
  return out;
}
