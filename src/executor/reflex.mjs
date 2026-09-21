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
import { Z_TOLERANCE, Y_TOLERANCE, PROJECTILE_RANGE, PROJECTILE_BLOCK_RANGE,
         PROJECTILE_ETA_TICKS } from '../state/arena.mjs';

/**
 * How close a hit has to be before blocking beats walking out of its way. A
 * swing needs several ticks of wind-up before its hitbox goes live, and walking
 * out of range during that wind-up costs nothing; once the hitbox is nearly
 * live there is no time to leave and the block is the only answer left.
 */
const BLOCK_WITHIN = 3;

/**
 * The most urgent incoming attack, if one is close enough to matter.
 * `ticks` is how long until its hitbox goes live; 0 means it already is.
 *
 * The window is a little wider than a single Jev round trip (~330 ms, about
 * ten ticks at 30 Hz) so blocking does not depend on a decision landing in
 * time. Raising it costs nothing: a block that covers a swing that never comes
 * is just a moment of guard.
 */
export function incoming(arena, { within = 10 } = {}) {
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
 * The nearest weapon currently flying at us, if one is close enough to matter.
 *
 * This is a separate alert from `incoming()` because there is no frame chain to
 * read: the weapon is already in the air, so the only warnings are its distance
 * and the fact that it is closing. In the recorded runs this is where the damage
 * actually came from — the enemy reads as `recovering` while the weapon travels.
 */
export function inboundWeapon(arena, { within = PROJECTILE_RANGE } = {}) {
  // Nearest first, so the weapon about to arrive is the one answered.
  for (const item of arena.flying ?? []) {
    if (item.range > within) continue;
    // `zGap` matters as much as it does for a swing: a weapon crossing at
    // another depth passes us by. Height is not checked because the pool read is
    // flat in practice and a false block is cheaper than a weapon in the chest.
    if (item.zGap > Z_TOLERANCE) continue;
    // Time to arrival off the measured closing speed. A weapon seen for the
    // first time has no speed yet, so it falls back to the distance.
    const eta = item.speed > 0 ? item.range / item.speed : Infinity;
    if (eta <= PROJECTILE_ETA_TICKS || item.range <= PROJECTILE_BLOCK_RANGE) {
      return { ...item, eta };
    }
  }
  return null;
}

/**
 * What the reflex layer wants, ahead of any decision. `null` means it has no
 * opinion and the policy's choice stands.
 *
 * There are two answers to an incoming swing, and which one is right depends on
 * how much time is left. A swing still winding up is answered by walking out of
 * its range — it costs nothing, keeps the initiative, and a block that never had
 * to happen cannot be guard-broken. A hitbox that is about to go live is
 * answered by blocking, because leaving is no longer possible.
 *
 * A thrown weapon gets the same two answers on the same rule, scaled by how far
 * away it is.
 *
 * When both are incoming, the live hitbox is decided first even though the
 * weapon may be nearer: blocking is the answer to both, whereas stepping out of
 * the weapon's line would still leave a hitbox that is about to go live.
 */
export function reflexAction(arena, opts = {}) {
  const threat = incoming(arena, opts);
  if (threat && threat.ticks <= BLOCK_WITHIN) {
    return { action: 'defend', reason: `hit from slot ${threat.slot} lands in ${threat.ticks} ticks — block`, threat };
  }
  // A thrown weapon is blocked, never outrun: it travels at us, so stepping back
  // keeps us on its line and spends the only ticks there were. There is no
  // distance branch — the trigger above is already the arrival time.
  const thrown = inboundWeapon(arena);
  if (thrown) {
    const when = Number.isFinite(thrown.eta) ? `~${thrown.eta.toFixed(1)} ticks out` : 'closing';
    return { action: 'defend',
             reason: `a thrown weapon ${Math.round(thrown.range)} away, ${when} — block`,
             threat: null };
  }
  if (!threat) return null;
  return { action: 'open_distance', reason: `hit from slot ${threat.slot} in ${threat.ticks} ticks — step out of its range`, threat };
}
