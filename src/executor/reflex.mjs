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
import { ticksToHit, reachOfFrame } from '../lf2data/frames.mjs';

/** A hit connects slightly outside the measured box, and depth must roughly match. */
const REACH_SLACK = 25;
const Z_TOLERANCE = 14;

/**
 * The most urgent incoming attack, if one is close enough to matter.
 * `ticks` is how long until its hitbox goes live; 0 means it already is.
 */
export function incoming(arena, { within = 6 } = {}) {
  let worst = null;
  for (const t of arena.threats) {
    if (t.zGap > Z_TOLERANCE) continue;
    const frames = framesFor(t.id);
    const ticks = ticksToHit(frames, t.frame, t.waiting, within);
    if (ticks === null) continue;
    const reach = reachOfFrame(frames?.[t.frame]) || 0;
    if (t.gap > reach + REACH_SLACK) continue;
    if (!worst || ticks < worst.ticks) worst = { slot: t.slot, ticks, reach, gap: t.gap };
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
 * What the reflex layer wants, ahead of any decision. `null` means it has no
 * opinion and the policy's choice stands.
 */
export function reflexAction(arena, opts = {}) {
  const threat = incoming(arena, opts);
  if (threat) return { action: 'defend', reason: `hit from slot ${threat.slot} in ${threat.ticks} ticks`, threat };
  return null;
}
