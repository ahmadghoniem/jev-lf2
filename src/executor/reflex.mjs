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
import { nextHit, nextSpawn, REACH_SLACK } from '../lf2data/frames.mjs';
import { Z_TOLERANCE, Y_TOLERANCE, doing } from '../state/arena.mjs';
import { BOT } from '../state/bot.mjs';

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
  for (const item of arena.items ?? []) {
    if (!item.hostile) continue;
    const eta = item.speed > 0 ? item.range / item.speed : Infinity;
    // Inside the CPU's 150, answer as it does. Beyond it, only when the weapon
    // is fast enough that waiting would leave no time to clear the lane: a
    // 43-units-per-read weapon first seen at 300 has seven reads left, which is
    // exactly what the step needs, and a slow one at the same distance has
    // dozens — nothing gained by standing off the lane for all of them.
    if (item.range > BOT.DODGE_X && eta > 15) continue;
    if (item.zGap > BOT.DODGE_Z) continue;
    return { ...item, eta };
  }
  return null;
}

/**
 * Depth between a star's line and us for it to fly past. In the Rudolf runs,
 * 1 of 16 stars passing at 16 or more hit, against 8 of 28 closer than that.
 */
export const LANE_CLEAR = 20;
/** Depth a standard fighter walks in a tick (walking_speedz 2.5 for Henry and Rudolf). */
const WALK_Z = 2.5;
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
  for (const item of arena.items ?? []) {
    if (!item.hostile || item.zGap >= LANE_CLEAR) continue;
    consider({ laneDz: item.dz, eta: item.speed > 0 ? item.range / item.speed : Infinity, what: 'star' });
  }
  for (const t of arena.threats) {
    if (t.zGap >= LANE_CLEAR || t.gap > THROW_RANGE || t.yGap > Y_TOLERANCE) continue;
    const facingUs = t.facing === (me.x >= t.x ? 'right' : 'left');
    if (!facingUs) continue;
    const spawn = nextSpawn(framesFor(t.id), t.frame, t.waiting);
    if (!spawn) continue;
    consider({ laneDz: t.dz, eta: spawn.ticks + Math.max(0, t.gap - spawn.ahead) / spawn.speed, what: 'throw' });
  }
  return worst;
}

/** The crouch after a jump or a flip lands, where Defend starts a roll. */
const LANDING = 215;
/** A star this close is rolled through on landing; the roll lasts about 13 ticks. */
const LAND_ROLL_ETA = 14;

/** px.js breaks a guard when a blocked hit takes the meter over this. */
export const GUARD_BREAK = 30;
const bdefendCache = new Map();
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
    // Landing from the flip is a 2-3 tick crouch on the same line, and the
    // next star was usually already on its way: 7 of 9 landings in two runs
    // were hit within 12 ticks. The crouch cannot walk, but px.js takes
    // Defend there as a roll (frame 215 -> 102), which nothing hits.
    if (arena.me.frame === LANDING && lane && lane.eta <= LAND_ROLL_ETA) {
      return { action: 'land_roll', owns: true, eta: lane.eta,
               reason: `${lane.what === 'star' ? 'a star' : 'a throw'} on our line in ~${lane.eta.toFixed(0)} ticks as we land — roll through it` };
    }
    const mine = doing(arena.me);
    const canMove = ['neutral', 'walking', 'running'].includes(mine);
    if (lane && canMove) {
      // `up` lowers z. Step away from the line, unless the edge of the stage
      // on that side is too close to get clear; a line straight through us
      // goes to the side with more room. A side that does not move us for
      // three ticks is recorded as the edge.
      const z = arena.me.z;
      const side = lane.laneDz > 1 ? 'up' : lane.laneDz < -1 ? 'down'
        : (evade?.dir ?? (room('up', z) >= room('down', z) ? 'up' : 'down'));
      const other = side === 'up' ? 'down' : 'up';
      const clearBy = (dir) => LANE_CLEAR + (dir === side ? -1 : 1) * Math.abs(lane.laneDz);
      const dir = room(side, z) >= clearBy(side) ? side : other;
      const need = clearBy(dir) / WALK_Z;
      // Short of time, the step is still taken when a block would break the
      // guard: that star lands either way, and a partial step may clear it. In
      // one run 534 hp went to stars, nearly all in chains that began with a
      // worn guard blocking while there was no time to step.
      const worn = (arena.me.guard ?? 0) + 16 > GUARD_BREAK + Math.floor(lane.eta);
      if ((lane.eta >= need || worn) && room(dir, z) >= clearBy(dir)) {
        if (evade?.dir === dir) {
          evade.still = Math.abs(z - evade.z) < 0.5 ? evade.still + 1 : 0;
          evade.z = z;
          if (evade.still >= 3) { walls[dir] = z; evade = null; }
        } else evade = { dir, z, still: 0 };
        return { action: dir === 'up' ? 'dodge_up' : 'dodge_down', thrown: true, eta: lane.eta,
                 reason: `${lane.what === 'star' ? 'a star' : 'a throw'} on our line in ~${lane.eta.toFixed(0)} ticks — step ${dir} off it` };
      }
    } else if (!lane) evade = null;

    // A broken guard cannot block at all — the wall is already down — so the
    // only answers left are to move or to hit back, which are the policy's.
    if (doing(arena.me) === 'broken_guard') { blocked = 0; return null; }

    const thrown = inboundWeapon(arena);
    if (thrown) {
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
               reason: `a thrown weapon ${Math.round(thrown.range)} away, ${when} — block it${worn ? ' (guard worn)' : ''}` };
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
    return null;
  };
}
