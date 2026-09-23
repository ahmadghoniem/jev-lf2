/**
 * Frame-level questions the executor asks many times a second.
 *
 * `Ts` gives the frame a fighter is in and `waiting` how many ticks it has been
 * there, so "is a hitbox live" and "how long until one is" are table lookups,
 * not predictions. That is what lets the reflex layer answer inside one tick
 * while the Jev call is still in flight.
 */

/**
 * itr kinds that actually hurt someone. `kind 0` is an ordinary attack and
 * `kind 6` a super punch; `kind 2` is the pick-up box and `kind 5` marks a
 * weapon's in-hand strength, whose `injury 789` is a placeholder the engine
 * replaces from the weapon's `<wsl>` table. Counting those as damage reads an
 * arrow as an 789-point attack.
 */
const HURTS = new Set([0, 6]);

/**
 * A hit connects slightly outside the box `reachOfFrame` measures, so every
 * reach comparison — the reflexes' whiff check, the executor's rush range, the
 * option hints and the offline whiff analysis — allows this much. One number,
 * because a policy that commits to a swing must agree with the analysis that
 * calls it a whiff.
 */
export const REACH_SLACK = 25;

export const damagingItr = (frame) =>
  (frame?.itr ?? []).filter((it) => HURTS.has(it.kind) && it.injury > 0);

/**
 * How far a frame's hit reaches past the fighter's own body, in game units.
 * Measured from the hurt box rather than from the sprite origin, because the
 * origin sits in different places on different characters.
 */
export function reachOfFrame(frame) {
  const hits = damagingItr(frame);
  if (hits.length === 0) return 0;
  const centre = frame.centerx ?? (frame.bdy?.[0] ? frame.bdy[0].x + frame.bdy[0].w / 2 : 0);
  return Math.max(...hits.map((it) => (it.x ?? 0) + (it.w ?? 0) - centre));
}

/**
 * The next damaging hitbox along this fighter's frame chain, or `null` if none
 * goes live inside the horizon. `ticks` is how long until it does — `0` means it
 * is live right now — and `reach` is how far *that* frame reaches.
 *
 * The reach has to come from the frame the hit lands on, not the frame the
 * fighter is in: a wind-up frame holds no itr at all, so its own reach is zero
 * and anyone comparing against it concludes the attack cannot possibly connect.
 * That is exactly the mistake that made the reflexes ignore every wind-up.
 *
 * Follows the frame chain through `next`, which is where the engine goes when
 * the current frame's `wait` runs out.
 */
export function nextHit(frames, frameId, waiting = 0, horizon = 12) {
  if (!frames) return null;
  let id = frameId;
  let elapsed = -waiting;
  for (let hop = 0; hop < 6; hop++) {
    const frame = frames[id];
    if (!frame) return null;
    if (damagingItr(frame).length > 0) {
      return { ticks: Math.max(0, elapsed), reach: reachOfFrame(frame) };
    }
    elapsed += (frame.wait ?? 1) + 1;
    if (elapsed > horizon) return null;
    const next = frame.next;
    if (typeof next !== 'number' || next <= 0 || next === id) return null;
    id = next;
  }
  return null;
}

/**
 * Ticks until this fighter's current animation throws something (a frame with
 * an `opoint`), and how fast it flies, or `null`. Rudolf's stars are thrown
 * from his punch frames, which have no hitbox of their own, so `nextHit` never
 * sees them coming.
 */
export function nextSpawn(frames, frameId, waiting = 0, horizon = 10) {
  if (!frames) return null;
  let id = frameId;
  let elapsed = -waiting;
  for (let hop = 0; hop < 6; hop++) {
    const frame = frames[id];
    if (!frame) return null;
    const thrown = (frame.opoint ?? []).find((o) => o.kind === 1 && Math.abs(o.dvx ?? 0) > 0);
    if (thrown) return { ticks: Math.max(0, elapsed), speed: Math.abs(thrown.dvx), ahead: thrown.x ?? 0 };
    elapsed += (frame.wait ?? 1) + 1;
    if (elapsed > horizon) return null;
    const next = frame.next;
    if (typeof next !== 'number' || next <= 0 || next === id) return null;
    id = next;
  }
  return null;
}

/** Ticks until this fighter's next damaging hitbox goes live, or `null`. */
export const ticksToHit = (frames, frameId, waiting = 0, horizon = 12) =>
  nextHit(frames, frameId, waiting, horizon)?.ticks ?? null;
