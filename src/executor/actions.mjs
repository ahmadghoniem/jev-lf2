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
import { DRINK_TYPE, Z_TOLERANCE, doing, unhittable, inSight } from '../state/arena.mjs';
import { REACH_SLACK } from '../lf2data/frames.mjs';
import { framesFor } from '../lf2data/tables.mjs';
import { LINE_ACTIONS, OFF_LINE } from '../state/line.mjs';
import { label } from '../state/options.mjs';
import { incoming, inboundWeapon, laneDanger } from './reflex.mjs';
import { BOT, createNoise, hesitation, standoffOf, DASH_MIN_GAP } from '../state/bot.mjs';

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
  (profile?.hasRanged && mp >= (profile.cheapestRangedMp ?? 0) ? standoffOf(profile) : 0);

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
function aimedAttack(keys, { tight, seq = ['attack'], needReach = false, reach = 45, startup = 5,
                             profile = null }) {
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
    // Defend while running is a roll and Attack is the run attack, so a run
    // is stopped first, by pressing against it. Started from the run, one
    // super arrow rolled Henry past Rudolf into the edge of the stage.
    if (step === 0 && mine === 'running') return { hold: [keys[opposite(a.me.facing)]] };
    if (step === 0 && !CAN_START.has(mine)) return { hold: [] };
    // A special opens with Defend, and the block pose that press starts lasts
    // 13 ticks, during which the fighter cannot step out of a star's line. In
    // one run 232 of 397 block-pose ticks came from specials. So one is not
    // started while a star or a throw would arrive before it fires; the
    // reflex steps off the line first, and the special starts after.
    if (step === 0) {
      const danger = laneDanger(a);
      if (danger && danger.eta < seq.length * 5 + startup) return { hold: [] };
    }
    // Out of sight nothing lands, so walk on until it is back in view.
    if (!inSight(t, profile)) {
      if (started()) step = 0;
      return { hold: toward(a, keys, t) };
    }
    // An enemy that goes down while the sequence is being played would take
    // the MP and nothing else — the observer saw blastpush fired into a
    // falling Rudolf — so the last press waits until it is up again. The same
    // for the plain shot: Henry's arrow costs 12 MP, and a shoot answer kept
    // firing at a Rudolf lying on the floor.
    if (unhittable(t)) {
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
        // The last press of a special waits while a star would land inside the
        // move's wind-up: Defend's block pose covers the earlier presses, but
        // after Attack the fighter is open, and in one run every blastpush
        // fired into Rudolf's stars was knocked out of its wind-up. The game's
        // reader stays armed without a timeout, so the wait loses nothing.
        const last = seq.length > 1 && step / 5 === seq.length - 1;
        // Rudolf's wind-up counts too: the star that knocked one blastpush out
        // was thrown a tick after Attack was pressed.
        const danger = last ? laneDanger(a) : null;
        if (danger && danger.eta <= startup + 2) return { hold: [] };
        const press = seq[step / 5];
        const code = press === 'forward' ? keys[dirTo(a.me, t)] : keys[press];
        step++;
        return { hold: [], tap: [code], special: seq.length > 1 };
      }
      step++;
      return { hold: [] };
    }
    // A special that repeats on Attack (Davis's ball, Henry's multiple shot,
    // Rudolf's stars) is pressed again while it plays, as long as the target
    // is still on the line and the MP holds: the next one then leaves at once,
    // where a fresh answer starts over from Defend, about a second later.
    if (seq.length > 1 && repeats(a.me) && Math.abs(dz) <= tight && t.infront) {
      return { hold: [], tap: [keys.attack], special: true };
    }
    return { hold: [] };
  };
  // A half-played sequence, which a repeat of the same answer should not restart.
  run.busy = started;
  return run;
}
/**
 * Wraps a movement stance so its depth keys aim `OFF_LINE` above or below the
 * enemy rather than level with it. The side is the one already stood on, kept
 * for the stance's life so it does not flicker as the gap passes zero.
 */
function offLine(step, keys) {
  let side = null;
  return (a) => {
    const out = step(a);
    const t = enemy(a);
    if (!t) return out;
    side ??= a.me.z > t.z ? 1 : -1;
    const dz = t.z + side * OFF_LINE - a.me.z;
    const hold = (out.hold ?? []).filter((k) => k !== keys.up && k !== keys.down);
    if (dz < -BOT.Z_DEADZONE) hold.push(keys.up);
    if (dz > BOT.Z_DEADZONE) hold.push(keys.down);
    return { ...out, hold };
  };
}

/**
 * Whether Attack pressed now carries the move on into another paid copy of
 * itself: some frame still ahead in this animation takes Attack to a frame
 * that costs MP (Davis's 246 -> 247), and the bar can pay for it.
 */
function repeats(me) {
  const frames = framesFor(me.id);
  let n = me.frame;
  for (let i = 0; i < 8 && frames?.[n]; i++) {
    const to = frames[n].transitions?.a;
    if (to != null && frames[to]?.mp > 0) return me.mp >= frames[to].mp;
    const next = frames[n].next;
    if (!next || next === 999 || next === n || next <= 0) return false;
    n = next;
  }
  return false;
}
/** States a hit leaves a fighter in, where key presses do nothing. */
const HURT = new Set(['staggered', 'broken_guard', 'knocked_down', 'in_the_air']);
/** What an attack sequence can start from; a block counts, since specials open with Defend. */
const CAN_START = new Set(['neutral', 'walking', 'blocking']);

export function planAction(name, { arena, profile, keys = P4_KEYS } = {}) {
  const { me, threats, held } = arena;
  const target = threats[0];

  // A movement played off the enemy's line (see src/state/line.mjs): the
  // same stance, with its depth keys aimed at a line beside the enemy's.
  if (name.includes('@')) {
    const [base, mod] = name.split('@');
    if (mod !== 'off' || !LINE_ACTIONS.includes(base) || !target) return null;
    const plan = planAction(base, { arena, profile, keys });
    return plan?.kind === 'stance' ? stance(offLine(plan.step, keys)) : plan;
  }

  if (name === 'wait') return stance(() => ({ hold: [] }));
  if (name === 'defend') {
    // Blocking only covers the side you face, so turning is part of blocking.
    // It lasts only while something is coming, by the same test that offers
    // the option: held until the next decision, a block against a star went on
    // 0.5-1 s after the star had passed, which read as blocking at nothing.
    // An enemy merely standing close is not something coming; held on that,
    // Henry blocked in punching range with nothing on its way.
    return stance((a) => {
      const t = enemy(a);
      const weapon = inboundWeapon(a);
      if (!incoming(a, { within: 12 }) && !weapon) return { hold: [] };
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
      // At the edge of the stage a step away goes nowhere and keeps his back
      // to the enemy, so he turns to face it instead.
      if (roomTo(a, opposite(dirTo(a.me, t))) < EDGE_ROOM) {
        return t.infront ? { hold: [] } : { hold: [], tap: [keys[dirTo(a.me, t)]] };
      }
      if (moveNoise(hesitation(1)) === 0) return { hold: [] };
      return { hold: away(a, keys, t) };
    });
  }

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

  // The game only reads a run from a double-tap, and a run goes on after the
  // key is let go, so it is a stance that also stops it (see `runStance`).
  if (name === 'run_in' || name === 'run_out') {
    if (!target) return null;
    const stopGap = (a) => Math.max(standoffFor(profile, a.me.mp), meleeReach(profile)) + RUN_SKID;
    return stance(runStance(keys, { toward: name === 'run_in', stopGap }));
  }

  // Leaving a thrown weapon's line, chosen by the reflex: the side is its call,
  // since it sees the stage edge; this only holds the key. Always the step,
  // never the jump: Rudolf's shuriken hits an airborne body, and in three runs
  // 45 of 65 jump dodges were hit within 25 ticks against 34 of 77 steps.
  if (name === 'land_roll') return stance(() => ({ hold: [], tap: [keys.defend] }));
  if (name === 'dodge_up' || name === 'dodge_down') {
    const key = name === 'dodge_up' ? keys.up : keys.down;
    return stance(() => ({ hold: [key] }));
  }

  // An enemy that is down, and a weapon on our lane, are both waited out by
  // the attack itself, tick by tick. Checked once here instead, a special
  // planned while Rudolf was in a jump stayed a do-nothing until the next
  // different answer, and every attack was dropped from the offer whenever
  // one of his stars was in the air, which against a steady thrower is often.

  // plain attacks: line up in the lane, face the target, then one tap. A melee
  // hit needs the CPU's tight 5 of depth; a fired shot is fine within the
  // looser 12. The punch only taps when the target is inside its reach, so it
  // stops whiffing from out of range.
  if (name === 'shoot' || name === 'punch' || name.startsWith('swing_')) {
    const melee = name !== 'shoot';
    // A shot with a measured reach walks in until it is inside it, like the
    // blastpush does with its full-damage band.
    const shotRange = !melee ? profile?.basicAttack?.range : null;
    return stance(aimedAttack(keys, { tight: melee ? BOT.ALIGN_Z_TIGHT : Z_TOLERANCE, profile,
                                       needReach: melee || !!shotRange,
                                       reach: melee ? meleeReach(profile) : (shotRange ?? 0) - REACH_SLACK }));
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
    return target ? stance(chargeStance(keys, { dash: false, reach: meleeReach(profile) })) : null;
  }
  if (name === 'dash_attack' || name.startsWith('dash_swing_')) {
    return target ? stance(chargeStance(keys, { dash: true, reach: meleeReach(profile) })) : null;
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
    return stance(aimedAttack(keys, { tight: Z_TOLERANCE, seq: SPECIAL_SEQUENCE[move.input], profile,
                                      startup: move.startupTicks ?? 5,
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
/**
 * A run at the enemy or away from it, ended by a press the other way.
 *
 * LF2 keeps a run going after the key is let go; only the opposite direction,
 * an attack, a jump or Defend ends it. The old burst double-tapped, held for
 * 520 ms and let go, and the run went on: in one run Henry ran in from x 56,
 * past Rudolf and into the right edge of the stage, then spent his last 250 hp
 * there, every run away pressing into the edge with his back to Rudolf. So
 * the run is held while it has somewhere to go, stopped, and then he turns to
 * face the enemy.
 */
function runStance(keys, { toward, stopGap }) {
  let phase = 'ready';
  let dir = null;
  let ticks = 0;
  return (a) => {
    const t = enemy(a);
    const now = doing(a.me);
    ticks++;
    if (phase === 'ready') {
      if (!t || !ACTIONABLE.has(now)) return { hold: [] };
      dir = toward ? dirTo(a.me, t) : opposite(dirTo(a.me, t));
      phase = roomTo(a, dir) < RUN_START_ROOM ? 'done' : 'tap';
      ticks = 0;
    }
    if (phase === 'tap') {
      if (ticks <= 1) return { hold: [keys[dir]] };
      if (ticks === 2) return { hold: [] };
      phase = 'run'; ticks = 0;
    }
    if (phase === 'run') {
      const there = !t || roomTo(a, dir) < RUN_EDGE
        || (toward ? dirTo(a.me, t) !== dir || t.gap <= stopGap(a) : ticks > RUN_TICKS);
      const never = now !== 'running' && ticks > RUN_START_TICKS;
      if (!there && !never) return { hold: [keys[dir]] };
      phase = 'stop'; ticks = 0;
    }
    if (phase === 'stop') {
      // Pressed on every other read, since held on it would walk back.
      if (now === 'running' && ticks <= 6) return ticks % 2 ? { hold: [] } : { hold: [keys[opposite(dir)]] };
      phase = 'done';
    }
    if (t && !t.infront && ACTIONABLE.has(now)) return { hold: [], tap: [keys[dirTo(a.me, t)]] };
    return { hold: [] };
  };
}
/**
 * A run attack, or a dash attack (a jump from the run, then Attack), one tick
 * at a time.
 *
 * As a timed burst it pressed from wherever the fighter was. Started while
 * Henry was down or crouching, the double-tap was lost, the Jump became a
 * plain jump and the Attack his 20-MP arrow from the air, fired at a Rudolf
 * lying on the floor. So it starts only from a stance that can run, at an
 * enemy that can be hit, and gives up without jumping if the run never shows.
 */
function chargeStance(keys, { dash, reach }) {
  let phase = 'ready';
  let dir = null;
  let ticks = 0;
  const run = (a) => {
    const t = enemy(a);
    const now = doing(a.me);
    ticks++;
    if (phase === 'ready') {
      if (!t || unhittable(t) || !ACTIONABLE.has(now)) return { hold: [] };
      dir = dirTo(a.me, t);
      phase = now === 'running' && a.me.facing === dir ? 'run' : 'tap';
      ticks = 0;
    }
    if (phase === 'tap') {
      if (ticks <= 1) return { hold: [keys[dir]] };
      if (ticks === 2) return { hold: [] };
      phase = 'run'; ticks = 0;
    }
    if (phase === 'run') {
      if (now !== 'running') {
        if (ticks > RUN_START_TICKS) { phase = 'done'; return { hold: [] }; }
        return { hold: [keys[dir]] };
      }
      // Closer than a dash carries, the dash goes past the enemy (Henry ended
      // 166 behind Rudolf that way), so the run's own attack is used instead.
      if (dash && t && t.gap >= DASH_MIN_GAP) { phase = 'dash'; ticks = 0; return { hold: [keys[dir]], tap: [keys.jump] }; }
      if (dash) { phase = 'done'; return { hold: [keys[dir]], tap: [keys.attack] }; }
      // The old burst swung about 8 ticks into the run; sooner once in reach.
      const there = !t || dirTo(a.me, t) !== dir || t.gap <= reach + RUN_SKID || ticks >= 8;
      if (!there) return { hold: [keys[dir]] };
      phase = 'done';
      return { hold: [keys[dir]], tap: [keys.attack] };
    }
    if (phase === 'dash') {
      // The burst's 160 ms from Jump to Attack.
      if (ticks < 5) return { hold: [keys[dir]] };
      phase = 'done';
      return { hold: [], tap: [keys.attack] };
    }
    return { hold: [] };
  };
  run.busy = () => phase !== 'ready' && phase !== 'done';
  return run;
}
/** Ticks a run away is held once running, about half a second. */
const RUN_TICKS = 16;
/** Ground a run needs ahead to start, and the ground at which it is stopped. */
const RUN_START_ROOM = 120;
const RUN_EDGE = 80;
/** A run stopped by the opposite key still slides on. */
const RUN_SKID = 40;
/** Closer than this to the edge, a step away goes nowhere. */
const EDGE_ROOM = 12;
/** Ground between the fighter and the stage edge in a direction. */
const roomTo = (a, dir) => (dir === 'left' ? a.me.x : (a.stageWidth ?? Infinity) - a.me.x);
const opposite = (dir) => (dir === 'right' ? 'left' : 'right');
/** What a fighter can start a run from. */
const ACTIONABLE = new Set(['neutral', 'walking', 'running']);
/** Reads it takes the game to show a run after the double-tap (about 4 measured), with margin. */
const RUN_START_TICKS = 10;

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
 * A weapon that is going to pass through our lane: in the air, inside the
 * CPU's own dodge range and depth. While one is, closing in does not follow
 * the enemy's depth, which would walk into the weapon's line.
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
