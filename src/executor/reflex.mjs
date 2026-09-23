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
import { nextHit, REACH_SLACK } from '../lf2data/frames.mjs';
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
 * A guard is *not* the answer here, whatever the distance. The damage ledger of
 * one loss run has 453 of 512 hp taken while staggered — every big projectile
 * hit was taken in the hit-stun of the previous one — and only 12 while
 * blocking. A shield absorbs a handful of hits and then breaks, so standing in
 * one while a weapon flies at you is how the spiral starts. The dodge is the
 * answer; the block is the last resort for a weapon that is already on top of
 * us and cannot be stepped away from.
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
  return function reflex(arena, opts = {}) {
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
