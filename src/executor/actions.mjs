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
import { DRINK_TYPE, doing, unhittable, inSight, airborne } from '../state/arena.mjs';
import { REACH_SLACK, animTicks, dashBand } from '../lf2data/frames.mjs';
import { framesFor } from '../lf2data/tables.mjs';
import { label, plainName, slug } from '../state/options.mjs';
import { incoming, inboundWeapon, laneDanger, itemUnderHand } from './reflex.mjs';
import { BOT, createNoise, hesitation, standoffOf, DASH_MIN_GAP, PRESS_EVERY } from '../state/bot.mjs';

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

/**
 * How far a bare-handed hit reaches, for deciding when to press attack: the
 * best melee move's reach, or the plain attack's when that is further. Deep's
 * best melee is a jump into a hit measured at 3, which would have held his
 * punch until he touched the enemy (its punch reaches 28).
 */
const meleeReach = (profile) => {
  const best = profile?.bestMelee?.reach, basic = profile?.basicAttack?.kind === 'melee' ? profile.basicAttack.reach : null;
  return (best == null && basic == null) ? 45 : Math.max(best ?? 0, basic ?? 0);
};

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
function aimedAttack(keys, { seq = ['attack'], needReach = false, reach = 45, startup = 5,
                             profile = null, homes = false }) {
  let step = 0;
  let side = null;    // the side of the enemy's line aimed from (see `aimSide`)
  let outTicks = 0;   // ticks spent stepping off the line before this attack
  let calls = 0;      // ticks this stance has run
  let pressedAt = -Infinity;   // the tick of its last press, sequence or repeat
  // A special whose own combo presses Jump (Uj, ja) puts us in 'in_the_air'
  // too, the same doing() a hit produces. Only the hit should abort the
  // sequence, so a jump we pressed ourselves is not read as one: Louis's
  // transform (ja) reached Defend, Jump, went airborne and sat there with
  // Attack never pressed (2026-09-27T20-37-29, tick 1104).
  let jumped = false;
  const started = () => step > 0 && step < seq.length * PRESS_EVERY;
  const run = (a, { down = [] } = {}) => {
    calls++;
    const t = enemy(a);
    if (!t) return { hold: [] };
    // Presses made while staggered or knocked about are read by nobody, and a
    // hit mid-sequence leaves it half played. In one run 38 of 40 blastpush
    // attempts ended this way: Henry pressed Defend (a block pose on screen),
    // got hit, and started over. So the sequence starts only from a stance
    // that can act, and a hit restarts it.
    const mine = doing(a.me);
    if (HURT.has(mine) && !(mine === 'in_the_air' && jumped)) {
      if (started()) step = 0;
      jumped = false;
      return { hold: [] };
    }
    if (mine !== 'in_the_air') jumped = false;
    // Defend while running is a roll and Attack is the run attack, so a run
    // is stopped first, by pressing against it. Started from the run, one
    // super arrow rolled Henry past Rudolf into the edge of the stage.
    if (step === 0 && mine === 'running') return { hold: [keys[opposite(a.me.facing)]] };
    if (step === 0 && !canStart(a.me, mine, seq)) return { hold: [] };
    // A special opens with Defend, and the block pose that press starts lasts
    // 13 ticks, during which the fighter cannot step out of a star's line. In
    // one run 232 of 397 block-pose ticks came from specials. So one is not
    // started while a star or a throw would arrive before it fires; the
    // reflex steps off the line first, and the special starts after.
    // A plain attack counts its whole animation, not just its wind-up: after
    // the shot Henry lowers the bow for 4 more ticks and can neither block nor
    // step, and 12 of 34 star chains in four games began inside one.
    if (step === 0) {
      const danger = laneDanger(a);
      const busy = seq.length === 1 ? Math.max(startup, animTicks(framesFor(a.me.id), ATTACK_FRAME)) : startup;
      if (danger && danger.eta < seq.length * PRESS_EVERY + busy) return { hold: [] };
    }
    // Out of sight nothing lands, so walk on until it is back in view.
    side = aimSide(side, a, t);
    if (!inSight(t, profile)) {
      if (started()) step = 0;
      return { hold: toward(a, keys, t, { zOff: side * BOT.AIM_Z }) };
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
    // A chasing ball finds its target from any depth, so it is fired as soon
    // as the fighter faces the enemy. Held back until the enemy was busy, it
    // left the ball unfired (2 in two games against 22, Freeze at 321 and 349
    // against 171 and 186).
    const anyDepth = homes;
    // Losing the lane mid-sequence restarts it: a half-played sequence (guard
    // and forward pressed, attack not) is neither a move nor a safe state to
    // resume from. A completed sequence is not restarted — that would be a
    // second cast paid for by the same answer.
    // Aim from beside the enemy's line rather than on it: too far off and
    // nothing connects, so step in; nearer than the CPU blocks from, step out
    // first, for at most AIM_OUT_TICKS so a stage edge cannot hold it forever.
    if (!anyDepth && Math.abs(dz) > BOT.AIM_MAX_Z) {
      if (step > 0 && step < seq.length * PRESS_EVERY) step = 0;
      return { hold: depthTo(a, keys, t.z + side * BOT.AIM_Z) };
    }
    // Only for a single press: a special's three presses already take about
    // half a second, and adding the step-out let the next answer cut it off.
    if (!anyDepth && step === 0 && seq.length === 1 && Math.abs(dz) < BOT.AIM_MIN_Z && outTicks < AIM_OUT_TICKS) {
      outTicks++;
      return { hold: depthTo(a, keys, t.z + side * BOT.AIM_Z) };
    }
    if (needReach && !started() && t.gap > reach + REACH_SLACK) {
      return { hold: toward(a, keys, t, { zOff: side * BOT.AIM_Z }) };
    }
    if (!t.infront) return { hold: [], tap: [keys[dirTo(a.me, t)]] };
    // One press every PRESS_EVERY ticks.
    if (step < seq.length * PRESS_EVERY) {
      if (step % PRESS_EVERY === 0) {
        // The last press of a special waits while a star would land inside the
        // move's wind-up: Defend's block pose covers the earlier presses, but
        // after Attack the fighter is open, and in one run every blastpush
        // fired into Rudolf's stars was knocked out of its wind-up. The game's
        // reader stays armed without a timeout, so the wait loses nothing.
        const last = seq.length > 1 && step / PRESS_EVERY === seq.length - 1;
        // Rudolf's wind-up counts too: the star that knocked one blastpush out
        // was thrown a tick after Attack was pressed.
        const danger = last ? laneDanger(a) : null;
        if (danger && danger.eta <= startup + 2) return { hold: [] };
        const press = seq[step / PRESS_EVERY];
        // A plain Attack over an item picks it up; step off its line first.
        const item = seq.length === 1 && press === 'attack' ? itemUnderHand(a) : null;
        if (item) return { hold: [item.dz >= 0 ? keys.up : keys.down] };
        const code = press === 'forward' ? keys[dirTo(a.me, t)] : keys[press];
        // A key still down is let go for a tick first: released and pressed
        // again inside one tick it never looks up to the game, and a tap of a
        // key whose tap is in flight is dropped. Either way the step is lost.
        // Over a block the reflex held, Defend was never pressed and Dennis
        // sat in the block pose (2026-09-28T20-34-26, tick 709); after a turn
        // tap, Forward was lost (2026-09-28T22-32-08, tick 1063). Across the
        // recorded runs, specials begun with Defend already down fired 155 of
        // 442 times (35%), against 1074 of 1836 (58%) with it up.
        if (seq.length > 1 && down.includes(code)) return { hold: [] };
        if (press === 'jump') jumped = true;
        step++;
        pressedAt = calls;
        return { hold: [], tap: [code], special: seq.length > 1 };
      }
      step++;
      return { hold: [] };
    }
    // A special that repeats on Attack (Davis's ball, Henry's multiple shot,
    // Rudolf's stars) is pressed again while it plays, as long as the target
    // is still on the line and the MP holds: the next one then leaves at once,
    // where a fresh answer starts over from Defend, about a second later.
    // Not into something about to land: each repeat is another wind-up.
    const landing = laneDanger(a);
    if (seq.length > 1 && repeats(a.me) && (anyDepth || Math.abs(dz) <= BOT.AIM_MAX_Z) && t.infront
      && !(landing && landing.eta <= startup + 2)) {
      pressedAt = calls;
      return { hold: [], tap: [keys.attack], special: true };
    }
    return { hold: [] };
  };
  // A half-played sequence, which a repeat of the same answer should not restart.
  run.busy = started;
  // A special being keyed in or chained, which a different answer waits for.
  // The next answer used to replace it on arrival: of 47 answers for Dennis's
  // energy ball in 4 games, 22 fired nothing and 6 went past one shot, the
  // chain mostly cut by a close_distance or a rush picked 10 ticks later
  // (2026-09-27T09-28-59 to 09-36-07). The gap covers the ticks between the
  // last press and the move's first frame, where no repeat is pressed yet.
  run.committed = () => seq.length > 1 && (started()
    || (step >= seq.length * PRESS_EVERY && calls - pressedAt <= COMMIT_GAP));
  return faced(keys, run);
}

/**
 * An attack stance turns to its target whenever the fighter could act and the
 * stance itself presses no sideways key. Stepping in depth to the enemy's line,
 * waiting out a star and the ticks after a swing hold only depth keys or none,
 * and those keep whatever facing the fighter had: Henry walked in depth for 30
 * ticks with his back to Rudolf before a blastpush (2026-09-25T13-36-37, ticks
 * 280-311). A sequence being played is left alone, since a direction between
 * its presses would be read as part of it.
 */
function faced(keys, run) {
  const step = (a, ctx) => {
    const out = run(a, ctx);
    const t = enemy(a);
    if (!t || t.infront || out.tap?.length || run.busy?.()) return out;
    if (!CAN_START.has(doing(a.me)) || Math.abs(t.x - a.me.x) <= BOT.X_DEADZONE) return out;
    if (out.hold.includes(keys.left) || out.hold.includes(keys.right)) return out;
    return { ...out, tap: [keys[dirTo(a.me, t)]] };
  };
  step.busy = run.busy;
  step.committed = run.committed;
  return step;
}
/** Ticks after a special's last press that it still holds the keys. */
const COMMIT_GAP = 4;

/**
 * A jump attack: face the enemy, Jump, and Attack on the way down. As a timed
 * burst it turned toward where the enemy stood when the answer was chosen and
 * pressed on whether or not the fighter could act; the turn was lost inside a
 * run attack's swing and the Attack came out as a punch with Dennis's back to
 * Freeze (2026-09-25T13-35-04, ticks 830-844). So it waits until the fighter
 * can act, re-reads the enemy every tick, and attacks only while facing it.
 */
function jumpAttackStance(keys, { reach = 0 } = {}) {
  let phase = 'ready';
  let ticks = 0;
  const run = (a) => {
    const t = enemy(a);
    ticks++;
    if (phase === 'ready') {
      if (!t || unhittable(t) || !CAN_START.has(doing(a.me))) return { hold: [] };
      if (!t.infront) return { hold: [], tap: [keys[dirTo(a.me, t)]] };
      phase = 'air'; ticks = 0;
      return { hold: [], tap: [keys.jump] };
    }
    if (phase === 'air' && ticks >= JUMP_TO_ATTACK) {
      phase = 'done';
      // The target picked at jump start is not who is still there 220 ms
      // later: it can be knocked down mid-air by something else, or simply
      // walk out of reach while the timer runs. Re-read both right before the
      // press instead of firing blind, the way the timed jump used to.
      if (t?.infront && !unhittable(t) && t.gap <= reach + REACH_SLACK) return { hold: [], tap: [keys.attack] };
    }
    return { hold: [] };
  };
  run.busy = () => phase === 'air';
  return faced(keys, run);
}
/** The old burst's 220 ms from Jump to Attack. */
const JUMP_TO_ATTACK = 7;
/**
 * A special that needs no target lined up — a heal, a teleport, a clone —
 * keyed as soon as the fighter can act, one press every PRESS_EVERY ticks.
 */
function keyedSpecial(keys, seq) {
  let step = 0;
  // A special whose own combo presses Jump (Uj, ja) puts us in 'in_the_air'
  // too, the same doing() a hit produces. Only the hit should abort the
  // sequence, so a jump we pressed ourselves is not read as one.
  let jumped = false;
  const run = (a) => {
    const mine = doing(a.me);
    if (HURT.has(mine) && !(mine === 'in_the_air' && jumped)) {
      if (step > 0 && step < seq.length * PRESS_EVERY) step = 0;
      jumped = false;
      return { hold: [] };
    }
    if (mine !== 'in_the_air') jumped = false;
    if (step === 0 && mine === 'running') return { hold: [keys[opposite(a.me.facing)]] };
    if (step === 0 && !canStart(a.me, mine, seq)) return { hold: [] };
    if (step >= seq.length * PRESS_EVERY) return { hold: [] };
    if (step % PRESS_EVERY === 0) {
      const press = seq[step / PRESS_EVERY];
      const t = enemy(a);
      const code = press === 'forward' ? keys[t ? dirTo(a.me, t) : a.me.facing] : keys[press];
      if (press === 'jump') jumped = true;
      step++;
      return { hold: [], tap: [code], special: seq.length > 1 };
    }
    step++;
    return { hold: [] };
  };
  run.busy = () => step > 0 && step < seq.length * PRESS_EVERY;
  run.committed = () => seq.length > 1 && run.busy();
  return run;
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
/** The standing attack's first frame, the same in every fighter's data. */
const ATTACK_FRAME = 60;
/** States a hit leaves a fighter in, where key presses do nothing. */
const HURT = new Set(['staggered', 'broken_guard', 'knocked_down', 'in_the_air']);
/** What an attack sequence can start from. */
const CAN_START = new Set(['neutral', 'walking']);
/**
 * From the block pose only what its frame carries a transition for goes off:
 * the standing block (frame 110) takes the specials, which open with Defend,
 * but has no plain Attack, and the frame a blocked hit holds (111) has none at
 * all. A punch pressed there is dropped and the pose runs its 13 ticks (12
 * ticks of Dennis blocking with a punch picked, 2026-09-25T12-23-32).
 */
function canStart(me, mine, seq) {
  if (CAN_START.has(mine)) return true;
  if (mine !== 'blocking' || seq.length < 2) return false;
  return Object.keys(framesFor(me.id)?.[me.frame]?.transitions ?? {}).length > 0;
}

export function planAction(name, { arena, profile, keys = P4_KEYS } = {}) {
  const { me, threats, held } = arena;
  const target = threats[0];

  // Waiting faces the enemy. A block and a special cover only the side faced,
  // and after a roll away Henry waited with his back to Rudolf until a star
  // turned him (2026-09-24T21-05-38, ticks 1376-1410).
  if (name === 'wait') {
    return stance((a) => {
      const t = enemy(a);
      return t && !t.infront && ['neutral', 'walking'].includes(doing(a.me))
        ? { hold: [], tap: [keys[dirTo(a.me, t)]] } : { hold: [] };
    });
  }
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
      // One level with us is passing through, and its side says nothing.
      const side = weapon && Math.abs(weapon.dx) > PASSING_DX ? (weapon.dx > 0 ? 'right' : 'left')
        : t ? dirTo(a.me, t) : a.me.facing;
      return { hold: side !== a.me.facing ? [keys[side], keys.defend] : [keys.defend] };
    });
  }

  // Closing is range-relative, not "walk at the enemy until you are touching
  // it". A fighter that can shoot stops at its firing band and only corrects
  // depth from there, which is how the game's own CPU fights: it answers the
  // lane question without walking into the melee.
  if (name === 'close_distance') {
    if (!target) return null;
    let side = null;
    return stance((a) => {
      const t = enemy(a);
      if (!t) return { hold: [] };
      side = aimSide(side, a, t);
      // While a weapon is inbound through our lane, depth is not corrected: the
      // enemy's projectile travels along the enemy's lane, so aligning with the
      // enemy is walking into its fire. The CPU suppresses lane-following while
      // a projectile is inbound for exactly this reason. The dodge stance owns
      // depth until the lane is clear; this holds only the sideways keys.
      // A throw still in its wind-up counts too: after the lane dodge gave up
      // on Deep's ball, close_distance pressed back toward his line and the
      // dash that followed jumped into it (2026-09-28T20-52-43, ticks 1073-1081).
      const w = weaponOnLane(a) ?? laneDanger(a);
      const stopAt = standoffFor(profile, a.me.mp);
      let hold = toward(a, keys, t, { stopAt, noDepth: !!w, zOff: side * BOT.AIM_Z });
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
  if (name === 'land_roll') return stance((a) => ({ hold: [keys[rollSide(a)]], tap: [keys.defend] }));
  // The punish reflex: face the enemy, then the ordinary attack.
  if (name === 'punish') {
    return target ? stance((a) => {
      const t = enemy(a);
      if (!t || itemUnderHand(a)) return { hold: [] };
      return t.infront ? { hold: [], tap: [keys.attack] } : { hold: [], tap: [keys[dirTo(a.me, t)]] };
    }) : null;
  }
  // No arrow held: a direction with Attack throws the held enemy instead.
  if (name === 'punch_held') return stance(() => ({ hold: [], tap: [keys.attack] }));
  if (name === 'hold_grip') return stance(() => ({ hold: [] }));
  if (name === 'dodge_up' || name === 'dodge_down') {
    const key = name === 'dodge_up' ? keys.up : keys.down;
    return stance(() => ({ hold: [key] }));
  }

  // An enemy that is down, and a weapon on our lane, are both waited out by
  // the attack itself, tick by tick. Checked once here instead, a special
  // planned while Rudolf was in a jump stayed a do-nothing until the next
  // different answer, and every attack was dropped from the offer whenever
  // one of his stars was in the air, which against a steady thrower is often.

  // plain attacks: step to the aiming depth beside the enemy's line, face the
  // target, then one tap. The punch only taps when the target is inside its
  // reach, so it stops whiffing from out of range.
  if (name === 'shoot' || name === 'punch') {
    if (itemUnderHand(arena)) return null;
    const melee = name !== 'shoot';
    // A shot with a measured reach walks in until it is inside it, like the
    // blastpush does with its full-damage band.
    const shotRange = !melee ? profile?.basicAttack?.range : null;
    return stance(aimedAttack(keys, { profile,
                                       needReach: melee || !!shotRange,
                                       reach: melee ? meleeReach(profile) : (shotRange ?? 0) - REACH_SLACK }));
  }

  if (name === 'jump_attack') {
    // Straight up, so only at an enemy level with us and inside the jump
    // attack's reach (options.mjs offers it only then; this covers an answer
    // that arrives after the enemy has moved).
    const jump = profile?.moves?.find((m) => m.name === 'jump_attack');
    if (jump?.kind === 'melee' && (!target || target.zGap > BOT.HIT_Z
        || target.gap > (jump.reach ?? 0) + REACH_SLACK)) return null;
    return stance(jumpAttackStance(keys, { reach: jump?.reach ?? 0 }));
  }

  // A charge at an enemy already inside the fighter's reach is the plain
  // attack. Run and dash attacks started within 50 of the enemy landed 17-18%
  // of the time (1686 answers), where a plain Attack pressed from there landed
  // 58-74%, and at a gap of a few units the run's direction flipped back and
  // forth as the enemy's x crossed ours (2026-09-28T20-48-22, tick 1209).
  if (name === 'run_attack' || name === 'dash_attack') {
    if (!target) return null;
    if (target.gap <= meleeReach(profile) + REACH_SLACK && target.zGap <= BOT.AIM_MAX_Z && !itemUnderHand(arena)) {
      // Logged as `as: 'punch'`, so the runs tell these apart from real charges.
      return { ...stance(aimedAttack(keys, { profile, needReach: true, reach: meleeReach(profile) })), as: 'punch' };
    }
    return stance(chargeStance(keys, { dash: name === 'dash_attack', reach: meleeReach(profile),
                                       band: name === 'dash_attack' ? dashBand(profile) : null,
                                       dashMove: profile.moves?.find((m) => m.name === 'dash_attack') ?? null }));
  }

  // specials, and the ranged basic attack of an archer, both come from hit_*
  if (name.startsWith('special_')) {
    const move = findSpecial(profile, name);
    if (!move || !SPECIAL_SEQUENCE[move.input]) return null;
    // Some specials go on to their hit only on a further Attack (Davis's and
    // Deep's jump into a hit).
    const seq = [...SPECIAL_SEQUENCE[move.input], ...(move.followUp ?? [])];
    if (move.kind === 'utility') {
      // A grab walks in to its reach and a lift faces the enemy, like an
      // attack; a heal, teleport, clone or the like is simply keyed.
      if (move.effect === 'grab' || move.effect === 'lift') {
        return stance(aimedAttack(keys, { seq, profile, startup: move.startupTicks ?? 5,
                                          needReach: move.effect === 'grab', reach: move.reach ?? 0 }));
      }
      return stance(keyedSpecial(keys, seq));
    }
    // A projectile that weakens with distance fires only inside its full-damage
    // band. The answer is chosen against where the enemy was half a second ago;
    // in one run Rudolf had backed off to 280 by the time Henry pressed, and two
    // 150-MP blastpushes did 13 and 7.
    // A melee special walks in to its own reach first, as the punch does.
    // A short-lived projectile is offered for as long as it still does damage
    // (its option states how much at the enemy's distance), so it fires from
    // where the fighter stands and only walks in once the enemy is past its end.
    const melee = move.kind === 'melee';
    return stance(aimedAttack(keys, { seq, profile, homes: !!move.homes,
                                      startup: move.startupTicks ?? 5,
                                      needReach: melee || !!move.range,
                                      reach: melee ? (move.reach ?? 0) : (move.range ?? 0) - REACH_SLACK }));
  }

  // punish a helpless enemy: close the distance, then hit once in range
  if (name === 'rush_attack') {
    if (!target) return null;
    const reach = meleeReach(profile);
    let side = null;
    return stance((a) => {
      const t = enemy(a);
      if (!t) return { hold: [] };
      side = aimSide(side, a, t);
      if (t.gap <= reach + REACH_SLACK && t.zGap <= BOT.AIM_MAX_Z) {
        // A plain Attack over an item picks it up: a rush pressed over a
        // lying weapon did (2026-09-25T04-27-43, tick 1385). Step off its line first.
        const item = itemUnderHand(a);
        if (item) return { hold: [item.dz >= 0 ? keys.up : keys.down] };
        return { hold: [], tap: [keys.attack] };
      }
      return { hold: toward(a, keys, t, { zOff: side * BOT.AIM_Z }) };
    });
  }

  // go and drink something: walk to it, then press attack on top of it
  if (name.startsWith('drink_')) {
    const pick = (a) => a.items.find((i) => i.type === DRINK_TYPE
      && `drink_${slug(plainName(i.name))}` === name) ?? null;
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
/**
 * Up or down to hold through a roll. Held, it carries the roll about 30 in
 * depth (measured: z 323 -> 352 and 359 -> 388 over the roll, none without),
 * which takes it off the enemy's line where a straight roll landed back on
 * it. Away from the enemy's line, unless the stage edge is nearer than that.
 * Only a roll whose frames carry a `dvz` is steered (Henry's 2, Julian's 3);
 * for the rest the held key moves only the run-up, 1-2 in the Dennis games.
 */
const ROLL_DZ = 30;
/** A roll's length in ticks (frames 102-107, about 13). */
const ROLL_TICKS = 14;
function rollSide(a) {
  const t = enemy(a);
  const { top = -Infinity, bottom = Infinity } = a.stageDepth ?? {};
  const room = { up: a.me.z - top, down: bottom - a.me.z };
  const away = !t ? null : t.z > a.me.z + 1 ? 'up' : t.z < a.me.z - 1 ? 'down' : null;
  if (away && room[away] >= ROLL_DZ) return away;
  return room.up >= room.down ? 'up' : 'down';
}
/**
 * The double-tap as holds, about the 60 ms press and 60 ms gap that
 * `kb.doubleTap` uses: two ticks down (the first is the tick that chose the
 * direction), one up, then held into the run. Null once the tap is done.
 *
 * A direction already down from the answer before is let go for a tick first.
 * Held on, its press was ticks old and the tap after it read as a walk: Dennis
 * walked a dash attack in from 196 to 64 after a close_distance held the same
 * key (2026-09-28T20-38-12, ticks 308-346). Across the recorded runs, dash
 * attacks started with the key down walked 10+ ticks without running 79 of 446
 * times (18%), against 16 of 1318 (1%) started with it up.
 */
function tapStep(ticks, key, wasDown) {
  const lead = wasDown ? 1 : 0;
  if (ticks < lead) return { hold: [] };
  if (ticks <= lead + 1) return { hold: [key] };
  if (ticks === lead + 2) return { hold: [] };
  return null;
}
function rollAway(keys) {
  let phase = 'ready';
  let dir = null;
  let side = null;
  let ticks = 0;
  let wasDown = false;
  return (a, { down = [] } = {}) => {
    const t = enemy(a);
    const now = doing(a.me);
    ticks++;
    if (phase === 'ready') {
      if (!t || !ACTIONABLE.has(now)) return { hold: [] };
      dir = dirTo(a.me, t) === 'right' ? 'left' : 'right';
      side = rollSide(a);
      phase = 'tap'; ticks = 0;
      wasDown = down.includes(keys[dir]);
    }
    if (phase === 'tap') {
      const tap = tapStep(ticks, keys[dir], wasDown);
      if (tap) return tap;
      phase = 'run'; ticks = 0;
      return { hold: [keys[dir]] };
    }
    if (phase === 'run') {
      if (now === 'running') { phase = 'roll'; ticks = 0; return { hold: [keys[side]], tap: [keys.defend], special: true }; }
      if (ticks > RUN_START_TICKS) { phase = 'done'; return { hold: [] }; }
      return { hold: [keys[dir]] };
    }
    // Up or down held through the roll steers it off the line.
    if (phase === 'roll' && ticks <= ROLL_TICKS) return { hold: [keys[side]] };
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
  let wasDown = false;
  return (a, { down = [] } = {}) => {
    const t = enemy(a);
    const now = doing(a.me);
    ticks++;
    if (phase === 'ready') {
      if (!t || !ACTIONABLE.has(now)) return { hold: [] };
      dir = toward ? dirTo(a.me, t) : opposite(dirTo(a.me, t));
      phase = roomTo(a, dir) < RUN_START_ROOM ? 'done' : 'tap';
      ticks = 0;
      wasDown = down.includes(keys[dir]);
    }
    if (phase === 'tap') {
      const tap = tapStep(ticks, keys[dir], wasDown);
      if (tap) return tap;
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
function chargeStance(keys, { dash, reach, band = null, dashMove = null }) {
  const near = band?.near ?? DASH_MIN_GAP, far = band?.far ?? Infinity;
  const dashReach = (dashMove?.reach ?? reach) + REACH_SLACK;
  const startup = dashMove?.startupTicks ?? 0;
  let phase = 'ready';
  let dir = null;
  let ticks = 0;
  // How far ahead of us the enemy was on the last tick, for the dash's closing speed.
  let lastAhead = null;
  // The smallest gap seen in the run, and the tick it was seen.
  let closest = Infinity;
  let closestAt = 0;
  let wasDown = false;
  const run = (a, { down = [] } = {}) => {
    const t = enemy(a);
    const now = doing(a.me);
    ticks++;
    // A run toward the enemy is a run along its line, into anything thrown or
    // cast down it, and the run cannot be steered off in time: Dennis stepped
    // up for 3 ticks while running and did not move in depth, then dashed into
    // Deep's energy ball from 242 away and died in the air (2026-09-28T20-52-43,
    // ticks 1073-1081). So no charge starts while something is coming down our
    // line, and one under way is stopped, as the other attacks already wait.
    // Once in the dash's jump there is nothing left to stop.
    if (phase !== 'dash' && phase !== 'done' && phase !== 'stop' && laneDanger(a)) {
      if (phase === 'run' && now === 'running') { phase = 'stop'; ticks = 0; }
      else { phase = 'ready'; return { hold: [] }; }
    }
    if (phase === 'ready') {
      if (!t || unhittable(t) || !ACTIONABLE.has(now)) return { hold: [] };
      closest = Infinity;
      // A run carries along its line, so it starts from the enemy's. Started
      // from 111 of depth away, run attacks swung left and right past Firen
      // (2026-09-24T20-28-06, ticks 1652-1705).
      if (Math.abs(t.z - a.me.z) > BOT.AIM_MAX_Z) return { hold: depthTo(a, keys, t.z) };
      dir = dirTo(a.me, t);
      phase = now === 'running' && a.me.facing === dir ? 'run' : 'tap';
      ticks = 0;
      wasDown = down.includes(keys[dir]);
    }
    // An enemy that crosses over before the run is under way is run at from
    // where it is now. Held to the first side, Dennis ran and swung away from a
    // Freeze that had slid past him (2026-09-25T13-35-04, ticks 825-829).
    const behind = t && dirTo(a.me, t) !== dir && Math.abs(t.x - a.me.x) > BOT.X_DEADZONE;
    if (behind && (phase === 'tap' || (phase === 'run' && now !== 'running'))) {
      phase = 'ready';
      return { hold: [] };
    }
    // Run past the enemy, the swing goes the other way, so the run is stopped
    // instead, which also turns the fighter back to it.
    if (behind && phase === 'run') { phase = 'stop'; ticks = 0; }
    // An enemy running away as fast as the fighter is never reached, so a run
    // that stops gaining on it is stopped and the choice goes back to Jev.
    // Swung on a timer instead, Henry's run attacks went off from 139-207
    // away at a Rudolf running from him (2026-09-27T18-19-13, ticks 233-706).
    if (phase === 'run' && now === 'running' && t) {
      if (t.gap < closest - CLOSING_MIN) { closest = t.gap; closestAt = ticks; }
      if (ticks - closestAt > NOT_CLOSING_TICKS) { phase = 'stop'; ticks = 0; }
    }
    if (phase === 'tap') {
      const tap = tapStep(ticks, keys[dir], wasDown);
      if (tap) return tap;
      phase = 'run'; ticks = 0;
    }
    if (phase === 'run') {
      if (now !== 'running') {
        if (ticks > RUN_START_TICKS) { phase = 'done'; return { hold: [] }; }
        return { hold: [keys[dir]] };
      }
      // Closer than a dash carries, the dash goes past the enemy (Henry ended
      // 166 behind Rudolf that way), so the run's own attack is used instead.
      // Depth is steered during the run, and the swing waits until it is level.
      const steer = t ? depthTo(a, keys, t.z) : [];
      const level = t && Math.abs(t.z - a.me.z) < BOT.HIT_Z;
      if (!level && ticks >= CHARGE_GIVE_UP) { phase = 'done'; return { hold: [] }; }
      // The dash jumps only from inside the gaps it hits from (`dashBand`),
      // and runs on until then. It jumped as soon as it was running and level,
      // from 242 into Deep's ball (2026-09-28T20-52-43, tick 1081), and 18% of
      // the recorded jumps from beyond the band hit.
      if (dash && t && t.gap > far) return { hold: [keys[dir], ...steer] };
      if (dash && t && t.gap >= near) {
        if (!level) return { hold: [keys[dir], ...steer] };
        phase = 'dash'; ticks = 0; lastAhead = aheadOf(a, t);
        return { hold: [keys[dir]], tap: [keys.jump] };
      }
      if (dash) {
        if (!level) return { hold: [keys[dir], ...steer] };
        phase = 'done'; return { hold: [keys[dir]], tap: [keys.attack] };
      }
      // Swung once in reach, with the ground the run slides on during the swing.
      const there = !t || t.gap <= reach + RUN_SKID;
      if (!there || !level) return { hold: [keys[dir], ...steer] };
      phase = 'done';
      return { hold: [keys[dir]], tap: [keys.attack] };
    }
    if (phase === 'stop') {
      // Pressed on every other read, since held on it would walk back.
      if (now === 'running' && ticks <= 6) return ticks % 2 ? { hold: [] } : { hold: [keys[opposite(dir)]] };
      phase = 'done';
    }
    if (phase === 'dash') {
      // Attack is pressed during the forward dash frame (state 5, facing the
      // way it dashes; the backward one takes no Attack) on the first tick the
      // hit would land in reach: the gap 1 + startup ticks on, at the speed it
      // is closing now. Pressed 5 ticks in only if the gap was within 99 then,
      // 8 of 14 dash jumps from inside the band never pressed, the gap still
      // 102-152 and closing about 20 a tick, and flew past the enemy
      // (2026-09-28T22-28 to 23-08, 1 hit). Across all runs, dash attacks
      // whose predicted gap was 30-90 hit 37 of 46 times (80%), under 0 hit 0 of 54,
      // over 90 hit 15 of 89 (17%) (scratch/dash-press-check.mjs).
      const frame = framesFor(a.me.id)?.[a.me.frame];
      if (frame?.state !== 5 || a.me.facing !== dir) {
        if (ticks <= DASH_START_TICKS) return { hold: [keys[dir]] };
        phase = 'done'; return { hold: [] };
      }
      const ahead = t ? aheadOf(a, t) : null;
      const closing = ahead !== null && lastAhead !== null ? lastAhead - ahead : 0;
      lastAhead = ahead;
      const atHit = ahead === null ? -1 : ahead - closing * (1 + startup);
      // Down, in the air, or passed: the swing would be wasted.
      if (!t || unhittable(t) || atHit < 0) { phase = 'done'; return { hold: [] }; }
      if (Math.abs(t.z - a.me.z) < BOT.HIT_Z && atHit <= dashReach) { phase = 'done'; return { hold: [], tap: [keys.attack] }; }
      return { hold: [keys[dir]] };
    }
    return { hold: [] };
  };
  run.busy = () => phase !== 'ready' && phase !== 'done';
  return faced(keys, run);
}
/** Ticks into a run after which a charge that never got level gives up. */
const CHARGE_GIVE_UP = 16;
/** Ticks after the dash's Jump that the crouch may take before the dash shows. */
const DASH_START_TICKS = 4;
/** How far ahead of the fighter the enemy is, along the way it runs. */
const aheadOf = (a, t) => (a.me.facing === 'left' ? -t.dx : t.dx);
/** A run that has not closed the gap by CLOSING_MIN in NOT_CLOSING_TICKS is stopped. */
const CLOSING_MIN = 8;
const NOT_CLOSING_TICKS = 6;
/** A weapon closer than this sideways is passing through, not coming from a side. */
const PASSING_DX = 12;
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
export const findSpecial = (profile, name) =>
  profile?.moves?.find((m) => `special_${label(m)}` === name) ?? null;

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
 * a fired move connect. The depth dead zone is the CPU's own 3. `zOff` aims
 * the depth beside the target's rather than at it (see `BOT.AIM_Z`).
 */
function toward(arena, keys, t, { stopAt = 0, xDead = BOT.X_DEADZONE, zDead = BOT.Z_DEADZONE,
                             noDepth = false, zOff = 0 } = {}) {
  if (!t) return [];
  const out = [];
  const dx = t.x - arena.me.x;
  const dz = t.z + zOff - arena.me.z;
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
 * Which side of the enemy's line to aim from: +1 for the larger depth, -1 for
 * the smaller. It follows the side Jev stands on once he is clearly off the
 * line, and keeps the last choice while he is near it, so it does not flip
 * as the gap passes zero.
 */
function aimSide(prev, arena, t) {
  if (prev == null || Math.abs(t.z - arena.me.z) >= BOT.AIM_MIN_Z) return arena.me.z >= t.z ? 1 : -1;
  return prev;
}

/** The depth keys that walk toward depth `z`, with a dead zone of 1. */
function depthTo(arena, keys, z) {
  const dz = z - arena.me.z;
  return dz < -1 ? [keys.up] : dz > 1 ? [keys.down] : [];
}

/** At most this long stepping off the line before an attack: ~0.3 s. */
const AIM_OUT_TICKS = 8;

/**
 * A weapon that is going to pass through our lane: in the air, inside the
 * CPU's own dodge range and depth. While one is, closing in does not follow
 * the enemy's depth, which would walk into the weapon's line.
 */
const weaponOnLane = (arena) =>
  airborne(arena).find((i) => i.hostile
    && i.zGap <= BOT.DODGE_Z && i.range <= BOT.DODGE_X) ?? null;

/** Options that press attack and cannot be cancelled once started. */
export const isAttackOption = (name) => name === 'shoot' || name === 'punch'
  || name === 'jump_attack' || name === 'run_attack' || name === 'dash_attack'
  || name.startsWith('special_') || name === 'rush_attack';

function away(arena, keys, t) {
  if (!t) return [];
  return [keys[dirTo(arena.me, t) === 'right' ? 'left' : 'right']];
}

const stance = (step) => ({ kind: 'stance', step, busy: step.busy ?? (() => false),
                            committed: step.committed ?? (() => false) });

/** Which of the offered options the executor can actually carry out. */
export function executableOptions(options, ctx) {
  const out = {};
  for (const [name, description] of Object.entries(options)) {
    if (planAction(name, ctx)) out[name] = description;
  }
  return out;
}
