/**
 * The sub-100 ms layer.
 *
 * A Jev round trip is about 330 ms and a Little Fighter attack can start and
 * land inside 150. Nothing that has to answer faster than a network call can
 * wait for one, so blocking and whiff suppression are decided locally from the
 * frame tables and reported separately in the log — otherwise a good result
 * could be the reflexes' doing and get credited to Jev.
 */

import { framesFor } from '../lf2data/tables.mjs';
import { nextHit, nextSpawn, reachOfFrame, REACH_SLACK } from '../lf2data/frames.mjs';
import { Z_TOLERANCE, Y_TOLERANCE, doing, unhittable, airborne } from '../state/arena.mjs';
import { BOT } from '../state/bot.mjs';
import { steers } from '../lf2data/profile.mjs';

/**
 * The most urgent incoming attack, if one is close enough to matter.
 * `ticks` is how long until its hitbox goes live; 0 means it already is.
 */
export function incoming(arena, { within = 6 } = {}) {
  let worst = null;
  for (const t of arena.threats) {
    // Same depth and the same height: an attack from a platform above or a
    // ledge below cannot reach us, so reacting to it is a wasted block.
    if (t.zGap > Z_TOLERANCE || t.yGap > Y_TOLERANCE) continue;
    const hit = nextHit(framesFor(t.id), t.frame, t.waiting, within);
    if (!hit) continue;
    // Measured on the frame the hitbox goes live on, not the one the fighter is
    // in — a wind-up frame reaches nowhere, which is how wind-ups went unseen.
    if (t.gap > hit.reach + REACH_SLACK) continue;
    if (!worst || hit.ticks < worst.ticks) {
      worst = { slot: t.slot, ticks: hit.ticks, reach: hit.reach, gap: t.gap };
    }
  }
  return worst;
}

/** Whether our own attack would reach anything from where we stand. */
export function wouldWhiff(arena, reach) {
  const t = arena.threats[0];
  if (!t) return true;
  return t.gap > reach + REACH_SLACK || t.zGap > Z_TOLERANCE;
}

/**
 * The nearest weapon that is actually going to hit us, if one is close enough
 * to matter.
 *
 * The trigger is the CPU's own dodge rule, read out of px.js: a projectile
 * inside 150 in x and 25 in depth gets stepped off the line. The old trigger —
 * arrival within 6 ticks or inside 45 — fired when the weapon was already
 * almost here, and the run data shows what that cost: the dodge held a key for
 * 180 ms and gained 5-7 units of separation where 25 were needed.
 *
 * The reflex answers such a weapon with a block (see `createReflex`): a star
 * blocked while the guard holds does no damage, and leaving its line early is
 * `laneDanger`'s job, which starts on the thrower's wind-up.
 */
export function inboundWeapon(arena) {
  // Read from the whole item list, not the flying list: a fast weapon only
  // crosses the 200-unit flying horizon for one or two reads before it lands,
  // and the run data shows exactly that — first flagged at r80 with 43 units
  // closing per read, hit two reads later. Whatever the range, a weapon that is
  // in the air, not carried, and closing at our lane gets the same answer.
  for (const item of airborne(arena)) {
    if (!item.hostile) continue;
    // Moving away: it has passed. Blocked anyway, a star that went by 23 off
    // our line turned Henry away from Rudolf (2026-09-24T20-37-48, tick 1175).
    if (item.speed < 0) continue;
    const eta = arrivalTicks(item);
    // Inside the CPU's 150, answer as it does. Beyond it, only when the weapon
    // is fast enough that waiting would leave no time to clear the lane: a
    // 43-units-per-read weapon first seen at 300 has seven reads left, which is
    // exactly what the step needs, and a slow one at the same distance has
    // dozens — nothing gained by standing off the lane for all of them.
    if (item.range > BOT.DODGE_X && eta > 15) continue;
    // Where its line will be when it arrives, not where it is now: see `arrivalDz`.
    if (Math.abs(arrivalDz(item, eta)) > BOT.DODGE_Z) continue;
    return { ...item, eta };
  }
  return null;
}

/** Half a fighter's body box (Dennis's is 43 wide, Henry's 43, Freeze's 41). */
const BODY_HALF = 20;
const contactCache = new Map();
/**
 * How far from our centre a flying object touches us: its hitbox's front edge
 * ahead of its own centre, plus half our body. Measured to the object's centre,
 * Freeze's ball hit Dennis from 42-51 away, where the arrival time still read
 * 5 ticks and more, and the special that started on that reading was hit in
 * its wind-up (2026-09-26T22-35-57, ticks 771-774). Read from the frames the
 * object flies in; 0 for an object whose data has no hitbox.
 */
export function contactRange(id) {
  if (!contactCache.has(id)) {
    // The frames it hits from while it flies; an object that hits standing
    // still (Freeze's ice columns rise where they are spawned) from those.
    const hitting = Object.values(framesFor(id) ?? {}).filter((f) => reachOfFrame(f) > 0);
    const flying = hitting.filter((f) => f.dvx);
    const reach = Math.max(0, ...(flying.length ? flying : hitting).map(reachOfFrame));
    contactCache.set(id, reach > 0 ? reach + BODY_HALF : 0);
  }
  return contactCache.get(id);
}

/**
 * Ticks until a flying object touches us: 0 once it is inside its contact
 * range, whatever its speed. An ice ball that has stopped against us reads
 * speed 0, and "never arrives" let a special start while it was hitting
 * (2026-09-26T22-35-57, tick 505).
 */
export function arrivalTicks(item) {
  const gap = Math.max(0, item.range - contactRange(item.id));
  if (gap === 0) return 0;
  return item.speed > 0 ? gap / item.speed : Infinity;
}

/**
 * Depth between a star's line and us for it to fly past. In the Rudolf runs,
 * 1 of 16 stars passing at 16 or more hit, against 8 of 28 closer than that.
 */
export const LANE_CLEAR = 20;
/** Depth a standard fighter walks in a tick (walking_speedz 2.5 for Henry and Rudolf). */
const WALK_Z = 2.5;

/**
 * A weapon's line minus ours when it arrives, if we stand still. A thrown
 * weapon keeps the thrower's depth speed (`vz`, per read like `eta`), so a
 * star thrown by a Rudolf walking toward our line drifts across it.
 */
const arrivalDz = (item, eta) => item.dz + (item.vz ?? 0) * (Number.isFinite(eta) ? eta : 0);

/**
 * Depth to walk in `dir` before a line that arrives `at` off ours is
 * LANE_CLEAR away. Away from the line that is what is missing; toward it, the
 * line has to be crossed first.
 */
const walkToClear = (dir, at) => ((dir === 'up' ? -at : at) <= 0
  ? Math.max(0, LANE_CLEAR - Math.abs(at)) : LANE_CLEAR + Math.abs(at));

/** How far ahead a swing is looked for when deciding to step out of it. */
const STEP_LOOKAHEAD = 10;
/** How far off a thrower in its wind-up is still worth leaving the lane for. */
const THROW_RANGE = 450;

/**
 * The line a thrown weapon will travel along through us, if one is coming:
 * a star already in the air, or an enemy facing us whose animation throws one
 * within the next few ticks. `laneDz` is the line's depth minus ours, and
 * `eta` the ticks until it arrives.
 */
export function laneDanger(arena) {
  const { me } = arena;
  let worst = null;
  const consider = (d) => { if (!worst || d.eta < worst.eta) worst = d; };
  for (const item of airborne(arena)) {
    if (!item.hostile) continue;
    // Moving away: it has passed. Its eta came out as Infinity, which every
    // step's time check passes, and a star that had just gone by walked
    // Henry up the stage for 259 ticks (2026-09-24T20-09-01, tick 1398).
    if (item.speed < 0) continue;
    const eta = arrivalTicks(item);
    const at = arrivalDz(item, eta);
    if (Math.abs(at) >= LANE_CLEAR) continue;
    consider({ laneDz: at, eta, what: item.energy ? 'ball' : 'star', id: item.id,
               homes: item.energy && steers(item.id, framesFor(item.id), item.frame) });
  }
  for (const t of arena.threats) {
    if (t.zGap >= LANE_CLEAR || t.gap > THROW_RANGE || t.yGap > Y_TOLERANCE) continue;
    const facingUs = t.facing === (me.x >= t.x ? 'right' : 'left');
    if (!facingUs) continue;
    const spawn = nextSpawn(framesFor(t.id), t.frame, t.waiting);
    if (!spawn) continue;
    const flight = Math.max(0, t.gap - spawn.ahead - contactRange(spawn.oid)) / spawn.speed;
    consider({ laneDz: t.dz, eta: spawn.ticks + flight, what: 'throw', id: spawn.oid });
  }
  return worst;
}

const SAYS = { star: 'a star', ball: 'an energy ball', throw: 'a throw' };

/** The crouch after a jump or a flip lands, where Defend starts a roll. */
const LANDING = 215;
/** A star this close is rolled through on landing; the roll lasts about 13 ticks. */
const LAND_ROLL_ETA = 14;

/** px.js breaks a guard when a blocked hit takes the meter over this. */
export const GUARD_BREAK = 30;
const bdefendCache = new Map();
/**
 * px.js lets a hit through a block when its bdefend is over this: Julian's
 * second ball (100) goes through the guard, so blocking it only roots us on its
 * line.
 */
const UNBLOCKABLE = 60;
export const unblockable = (id) => bdefendOf(id) > UNBLOCKABLE;
/** The most a weapon adds to the guard meter when blocked (Rudolf's star: 12-16). */
function bdefendOf(id) {
  if (!bdefendCache.has(id)) {
    let most = 0;
    for (const f of Object.values(framesFor(id) ?? {})) {
      for (const i of f.itr ?? []) if (i.kind === 0) most = Math.max(most, i.bdefend ?? 0);
    }
    bdefendCache.set(id, most || 16);
  }
  return bdefendCache.get(id);
}

/**
 * Whether blocking this weapon leaves the guard standing. The meter falls by
 * one a tick until the weapon arrives, then the block adds the weapon's
 * bdefend. Right after a clean hit the meter is 45, so the first star blocked
 * in the next half second breaks the guard.
 */
export function guardHolds(me, weapon) {
  const eta = Number.isFinite(weapon?.eta) ? Math.floor(weapon.eta) : 0;
  return Math.max(0, (me.guard ?? 0) - eta) + bdefendOf(weapon?.id) <= GUARD_BREAK;
}

/**
 * What the reflex layer wants, ahead of any decision. `null` means it has no
 * opinion and the policy's choice stands.
 *
 * A swing is blocked for the moment it is live, then left to the policy: an
 * answer describing the fight from 300 ms ago is usually the better call, and
 * letting every reflex override the policy is what starved Jev's attacks. A
 * thrown weapon is the exception — it is already travelling and only the block
 * stops it — so it is marked and allowed to hold against a late answer.
 *
 * The block is deliberately finite. The game's own CPU blocks only while the
 * enemy is actually in an attack frame, commits for about ten frames, and then
 * re-decides; it is never seen standing in a guard while it is hit. Holding the
 * guard indefinitely is what the runs are full of — 89% of the damage in one
 * loss arrived while defending — because a block absorbs a few hits and then
 * breaks. So this counts its own consecutive blocks, stops once the budget is
 * spent, and rests for a few frames so the policy can answer instead of guarding
 * again. The counter itself is the policy's job: a blocked swing leaves the
 * enemy in its recovery tail, which the options layer already marks as a window.
 *
 * It is stateful, so the caller holds one per run and passes the arena in each
 * tick, exactly like the held-weapon and liveness trackers.
 */
export function createReflex({ maxBlockTicks = BOT.BLOCK_COMMIT_FRAMES,
                               restTicks = BOT.BLOCK_REST_FRAMES } = {}) {
  let blocked = 0;
  let rest = 0;
  let evade = null; // { dir, z, still }: the side being stepped to, to notice a wall
  // The depth each stage edge was found at, kept for the run. In one run Henry
  // stepped up into the top edge (z 326) and stood there the rest of the
  // match, so every later "step up" went nowhere.
  const walls = { up: null, down: null };
  const room = (dir, z) => (walls[dir] == null ? Infinity : Math.abs(z - walls[dir]));
  return function reflex(arena, opts = {}) {
    // Leave the line before the star is on it. Standing in it and blocking
    // wears the guard out in two or three stars and then every star lands
    // (the observer: "run towards a different lane instead of standing and
    // defending"). The older depth step failed because it started only once
    // the star was within 150, too late at 2.5 depth a tick; this starts on
    // Rudolf's wind-up and only when there is time to get clear.
    // No air recovery. Jump on the way down flips a fighter upright (px.js,
    // frame 182 or 188), but the flip lands it standing, where the lying
    // fighter is out of reach: in six runs with the flip Henry took 34-112 hp
    // per 100 ticks against 27-30 in the three before it, and nothing ever
    // hit him while he lay on the floor.
    // Holding an enemy by the neck (walking into a dizzy one grabs it). The
    // held frame takes Attack as a punch (its cpoint `aaction`), for the
    // catcher's own data, and nothing can hit the pair meanwhile. Left to
    // the policy, the hold ran out untouched: 22 ticks of a run_attack
    // stance holding the arrow key at tick 784 of 2026-09-24T02-44-46.
    const grip = framesFor(arena.me.id)?.[arena.me.frame]?.cpoint?.find((c) => c.kind === 1);
    if (grip) {
      return { action: grip.aaction ? 'punch_held' : 'hold_grip', owns: true,
               reason: 'holding the enemy — punch it while the grip lasts' };
    }
    const lane = laneDanger(arena);
    // Landing from a jump or a fall is a 2-3 tick crouch on the same line, and the
    // next star was usually already on its way: 7 of 9 landings in two runs
    // were hit within 12 ticks. The crouch cannot walk, but px.js takes
    // Defend there as a roll (frame 215 -> 102), which nothing hits.
    if (arena.me.frame === LANDING && lane && lane.eta <= LAND_ROLL_ETA) {
      return { action: 'land_roll', owns: true, eta: lane.eta,
               reason: `${SAYS[lane.what]} on our line in ~${lane.eta.toFixed(0)} ticks as we land — roll through it` };
    }
    const mine = doing(arena.me);
    const canMove = ['neutral', 'walking', 'running'].includes(mine);
    // A ball that steers follows us off any line we step to, so stepping only
    // costs the time a block needs; it is blocked below instead.
    if (lane && canMove && !lane.homes) {
      // `up` lowers z. Step away from the line, unless the edge of the stage
      // on that side is too close to get clear; a line straight through us
      // goes to the side with more room. A side that does not move us for
      // three ticks is recorded as the edge. `laneDz` is where the line will
      // be on arrival, so a star drifting after us needs its drift outwalked,
      // which at the same walking pace never happens: it is blocked instead.
      const z = arena.me.z;
      const side = lane.laneDz > 1 ? 'up' : lane.laneDz < -1 ? 'down'
        : (evade?.dir ?? (room('up', z) >= room('down', z) ? 'up' : 'down'));
      const other = side === 'up' ? 'down' : 'up';
      const clearBy = (dir) => walkToClear(dir, lane.laneDz);
      const dir = room(side, z) >= clearBy(side) ? side : other;
      const need = clearBy(dir) / WALK_Z;
      // Short of time, the step is still taken when a block would break the
      // guard: that star lands either way, and a partial step may clear it. In
      // one run 534 hp went to stars, nearly all in chains that began with a
      // worn guard blocking while there was no time to step.
      // What the block would add is read from the object itself: an ice ball's
      // 16, a chaser's 60, or past what any guard stops.
      const worn = (arena.me.guard ?? 0) + bdefendOf(lane.id) > GUARD_BREAK + Math.floor(lane.eta);
      if ((lane.eta >= need || worn) && room(dir, z) >= clearBy(dir)) {
        if (evade?.dir === dir) {
          evade.still = Math.abs(z - evade.z) < 0.5 ? evade.still + 1 : 0;
          evade.z = z;
          if (evade.still >= 3) { walls[dir] = z; evade = null; }
        } else evade = { dir, z, still: 0 };
        return { action: dir === 'up' ? 'dodge_up' : 'dodge_down', thrown: true, eta: lane.eta,
                 reason: `${SAYS[lane.what]} on our line in ~${lane.eta.toFixed(0)} ticks — step ${dir} off it` };
      }
    } else if (!lane) evade = null;

    // A broken guard cannot block at all — the wall is already down — so the
    // only answers left are to move or to hit back, which are the policy's.
    if (doing(arena.me) === 'broken_guard') { blocked = 0; return null; }

    // A block does nothing against a hit that goes through it: stepping (above)
    // was the answer, and short of that the policy's own, a special that meets
    // it or a roll, are the rest.
    const thrown = inboundWeapon(arena);
    if (thrown && !unblockable(thrown.id)) {
      const when = Number.isFinite(thrown.eta) ? `~${thrown.eta.toFixed(0)} ticks out` : 'closing';
      // The block, not the depth step. Against Rudolf's stars the step is where
      // the damage came from: in the three Henry vs Rudolf runs of 2026-09-23,
      // 1,113 of 1,462 hp was lost while the reflex was stepping, and 17 while
      // blocking. px.js lets a hit through a block only when its bdefend is over
      // 60, and a thrown star's is 12. (The older note that guards broke came
      // from energy balls in the Deep/Firen runs.)
      // A block the meter cannot take still stops this star, but the guard
      // breaks and the next one lands: in the 2026-09-23 runs Rudolf threw
      // steadily from 150-220 and this block-break-stagger cycle cost most of
      // the HP. So a worn block is marked, and an attack or roll Jev chose
      // takes the keys instead.
      const worn = !guardHolds(arena.me, thrown);
      return { action: 'defend', thrown: true, worn, threat: null, eta: thrown.eta,
               reason: `${thrown.energy ? 'an energy ball' : 'a thrown weapon'} ${Math.round(thrown.range)} away, ${when} — block it${worn ? ' (guard worn)' : ''}` };
    }

    // A swing seen early enough is stepped out of rather than blocked: a hit
    // lands only inside 16 of depth (the default zwidth, px.js), and a block
    // roots Jev on the line while the CPU keeps swinging. In four runs 500 of
    // the ticks spent on the enemy's line were blocking, most ending in a
    // broken guard. Late swings are still blocked as before.
    const early = incoming(arena, { ...opts, within: STEP_LOOKAHEAD });
    const foe = early && arena.threats.find((x) => x.slot === early.slot);
    if (foe && canMove) {
      const z = arena.me.z;
      const need = Math.max(0, BOT.HIT_Z - foe.zGap) / WALK_Z;
      const dir = foe.z > z ? 'up' : foe.z < z ? 'down' : (room('up', z) >= room('down', z) ? 'up' : 'down');
      if (early.ticks >= need + 1 && room(dir, z) >= BOT.HIT_Z) {
        return { action: dir === 'up' ? 'dodge_up' : 'dodge_down', eta: early.ticks,
                 reason: `a swing from slot ${early.slot} in ${early.ticks} ticks — step ${dir} out of its reach` };
      }
    }
    const threat = incoming(arena, opts);
    if (threat) {
      // Inside the rest window the guard stays down on purpose: the swing has
      // passed, and the better answer is the counter the policy is about to pick.
      if (rest > 0) { rest--; return null; }
      if (blocked >= maxBlockTicks) { blocked = 0; rest = restTicks; return null; }
      blocked++;
      return { action: 'defend', reason: `hit from slot ${threat.slot} in ${threat.ticks} ticks`, threat };
    }
    blocked = 0;
    if (rest > 0) rest--;
    return punish(arena, opts.profile);
  };
}

/**
 * Hit an enemy stuck in a recovery the moment it is in reach, as the CPU does:
 * it swings 1 time in 3 every tick a target is in range (docs/07-cpu-ai.md),
 * where an answer from Jev arrives up to a second later, after the window.
 * The ordinary attack only, read from the fighter's own profile: a swing
 * inside its reach, or a shot inside its range while the MP covers it. Depth
 * within `BOT.AIM_MAX_Z`, where a hit still lands.
 */
/** The standing attack's first frame, where its pick box is. */
const PUNCH_FRAME = 60;
/** Half the width of an item lying on the ground (a weapon's body is 19 wide). */
const ITEM_HALF = 10;

/**
 * An item lying inside the standing attack's pick box (its itr kind 2, px.js):
 * Attack from a stance picks it up instead of attacking. In
 * 2026-09-24T20-06-11 the punish reflex picked up a baseball bat 14 in front
 * of Henry, and its next press threw it.
 */
export function itemUnderHand(arena) {
  const f = framesFor(arena.me.id)?.[PUNCH_FRAME];
  const box = f?.itr?.find((i) => i.kind === 2);
  if (!box) return null;
  const from = box.x - (f.centerx ?? 0);
  const to = from + box.w;
  const ahead = arena.me.facing === 'right' ? 1 : -1;
  return (arena.items ?? []).find((i) => !i.inFlight && Math.abs(i.dz) < (box.zwidth ?? BOT.HIT_Z)
    && ahead * i.dx + ITEM_HALF >= from && ahead * i.dx - ITEM_HALF <= to) ?? null;
}

/**
 * Injured and dizzy: on its feet, reeling from a hit, and unable to act. The
 * next hit carries the combo on, where an answer from Jev lands after the
 * stagger is over. With it not counted, a Davis staggered by two hits of a
 * rush was given a jump attack from 44 away, which missed, and Dennis took 45
 * on landing (2026-09-27T09-36-07, ticks 1780-1825); across 4 games a
 * staggered enemy in reach drew 9 punches and 8 jump attacks from Jev.
 */
const STUNNED = new Set([11, 16]);
const stunned = (t) => STUNNED.has(framesFor(t.id)?.[t.frame]?.state);

export function punish(arena, profile) {
  const t = arena.threats[0];
  const basic = profile?.basicAttack;
  if (!t || !basic || !(t.vulnerable || stunned(t)) || unhittable(t)) return null;
  if (itemUnderHand(arena)) return null;
  // Not with a star or a throw on our line: the attack's animation roots us
  // on it until the star lands.
  if (laneDanger(arena)) return null;
  if (!['neutral', 'walking'].includes(doing(arena.me))) return null;
  if (t.zGap > BOT.AIM_MAX_Z) return null;
  const inReach = basic.kind === 'ranged'
    ? t.gap <= (basic.range ?? 0) && (arena.me.mp ?? 0) >= (basic.mp ?? 0)
    : t.gap <= (basic.reach ?? 0) + REACH_SLACK;
  if (!inReach) return null;
  return { action: 'punish', reason: `${t.name ?? 'the enemy'} is ${t.doing} in reach — hit it now` };
}
