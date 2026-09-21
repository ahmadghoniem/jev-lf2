/**
 * Turns a pool read into the view everything else works from.
 *
 * Two shapes come out of here. The *arena* is numeric and is what the executor
 * and the reflexes use — distances, who is where, what is in hand. The
 * *semantic state* is what Jev sees, and it carries no raw numbers at all,
 * because Jev is documented as unreliable at comparing them and there is no
 * reason to make it try.
 */

import { readFighter, MP_CAP } from './fields.mjs';
import { framesFor, BUSY_STATES } from '../lf2data/tables.mjs';
import { ticksToHit } from '../lf2data/frames.mjs';
import { bucketRange } from '../lf2data/profile.mjs';
import { plainName } from './options.mjs';

/** Data-file types that can be picked up. 6 is milk and beer. */
const ITEM_TYPES = new Set([1, 2, 4, 6]);
const DRINK_TYPE = 6;

/**
 * A hit only connects when attacker and target share roughly the same depth,
 * and a straight attack leaves at the attacker's own height. Coordinates are
 * `x` horizontal, `y` vertical (negative is up) and `z` depth, so a target that
 * is a long way off in `z` is missed by anything fired from where we stand even
 * though `x` says it is right in front. These are the arithmetic thresholds;
 * `docs/05-live-state.md` is where the axes come from.
 */
export const Z_TOLERANCE = 12;
export const Y_TOLERANCE = 30;

/**
 * A weapon in hand sits at its holder's exact depth and rides along with it,
 * while a weapon on the ground keeps its own. A field that states the link
 * outright has not been found, so this confirms the proximity guess by motion:
 * an item being carried keeps a near-fixed offset to the fighter across reads,
 * while one the fighter is merely standing next to drifts as it moves. Two
 * reads are enough, and a false positive needs the fighter and a loose weapon
 * to be perfectly still at hand offset. Stateful, so one per run.
 */
const HELD_DX = 45;
const HELD_DZ = 2;

/**
 * A weapon on the ground stays where it is; a thrown weapon crosses the stage,
 * and one crossing toward us is the single most common way this harness gets
 * hit. Nothing in the entity states which is which, so flight is read from
 * motion: an item that has moved this far since the previous read is in the air.
 * At 30 Hz a thrown weapon covers far more ground between reads than a resting
 * one, which moves not at all.
 */
const FLIGHT_SLACK = 6;
/** An in-flight weapon inside this range, closing, is worth answering. */
export const PROJECTILE_RANGE = 110;

/**
 * How a thrown weapon is answered is a question of time, not distance.
 *
 * A distance threshold asks "is it inside 45 yet", which has no answer for a
 * weapon crossing that line between two reads: at 50 the block does not start,
 * and by the next read it has already landed. What matters is how many ticks are
 * left before it arrives, so the trigger is the arrival time and the distance is
 * only a fallback for the first sighting, before a speed has been measured.
 */
export const PROJECTILE_ETA_TICKS = 6;
/** Fallback when the weapon has only been seen once and has no measured speed. */
export const PROJECTILE_BLOCK_RANGE = 45;

export function createItemMotion({ slack = FLIGHT_SLACK } = {}) {
  const prev = new Map();
  return (item) => {
    const now = { x: Math.round(item.x), z: Math.round(item.z), range: item.range };
    const was = prev.get(item.slot);
    prev.set(item.slot, now);
    if (!was) return { inFlight: false, closing: false, speed: 0 };
    const moved = Math.hypot(now.x - was.x, now.z - was.z);
    return { inFlight: moved > slack, closing: now.range < was.range,
             // Units closed per read, which is what turns distance into time.
             speed: was.range - now.range };
  };
}

/**
 * Whether a weapon is in our hands, read from whether it moves with us.
 *
 * A read only carries evidence when we actually moved. Standing still, a weapon
 * lying at our feet holds exactly the offset a carried one does, so "the offset
 * did not change" confirms a weapon we are not holding — and the recordings show
 * what that costs: a knife thrown at us was claimed as our own the moment it
 * came inside `HELD_DX`, 203 ticks of one loss run reading `holding
 * rudolf_weapon` with 152 changes of mind. The verdict is therefore only revised
 * when our own displacement makes the two cases distinguishable, and otherwise
 * the last verdict stands.
 */
export function createHeldTracker({ slack = 4 } = {}) {
  const prev = new Map();
  const verdict = new Map();
  return (me, item) => {
    const mx = Math.round(me.x);
    const mz = Math.round(me.z);
    const dx = Math.round(item.x - me.x);
    const dz = Math.round(item.z - me.z);
    const was = prev.get(item.slot);
    prev.set(item.slot, { dx, dz, mx, mz });
    if (!was) return false;
    const moved = Math.abs(was.mx - mx) > slack || Math.abs(was.mz - mz) > slack;
    // No evidence this read: keep what we last concluded rather than restating
    // "still holding it" from a read that could not tell the difference.
    if (!moved) return verdict.get(item.slot) ?? false;
    const stable = Math.abs(was.dx - dx) <= slack && Math.abs(was.dz - dz) <= slack;
    verdict.set(item.slot, stable);
    return stable;
  };
}

/**
 * The entity pool keeps fighters from a finished match. They still read as
 * alive, at whatever health they ended on, and nothing in the entity marks them
 * as retired — a summary screen after a 1v1 was found holding two fighters from
 * the match before it, which the executor then counted as enemies and walked
 * toward.
 *
 * What separates them from a real fighter is that nothing about them changes.
 * A fighter in play always moves through frames, and `waiting` counts down on
 * every one, so a signature that has not changed for a second belongs to an
 * entity the game has stopped simulating.
 *
 * This is stateful, so the caller holds one per run and passes it in. Items are
 * deliberately not checked: a weapon lying on the ground is motionless and
 * still very much real.
 */
export function createLiveness({ staleMs = 1000 } = {}) {
  const seen = new Map();
  return (f) => {
    const sig = `${f.frame}:${f.waiting}:${Math.round(f.x)}:${Math.round(f.y)}:${Math.round(f.z)}:${f.hp}`;
    const prev = seen.get(f.slot);
    const now = Date.now();
    if (!prev || prev.sig !== sig) {
      seen.set(f.slot, { sig, at: now });
      return true;
    }
    return now - prev.at < staleMs;
  };
}

/**
 * `human` is the reliable way to find our own fighter, and the only one that
 * survives Phase 1: Jev and a COM playing the *same character* means the name
 * matches two entities. An explicit slot wins over it; the name is a last
 * resort for a run where no slot is human-controlled.
 */
export function readArena(entities, { slot, name, isLive, heldTracker, motionTracker } = {}) {
  const fighters = entities.filter((e) => e.type === 0).map(readFighter);
  const me = (slot !== undefined && fighters.find((f) => f.slot === slot))
    || fighters.find((f) => f.human)
    || (name && fighters.find((f) => f.name?.toLowerCase() === name.toLowerCase()));
  if (!me) return null;

  // Our own fighter is never liveness-checked: lying dead is motionless, and
  // dropping ourselves would end the run.
  const others = fighters.filter((f) => f !== me && f.alive && (!isLive || isLive(f)));
  const geo = (e) => {
    const dx = e.x - me.x;
    const dz = e.z - me.z;
    const dy = e.y - me.y;
    return { ...e, dx, dz, dy, gap: Math.abs(dx), zGap: Math.abs(dz), yGap: Math.abs(dy),
             range: Math.hypot(dx, dz),
             side: dx >= 0 ? 'right' : 'left',
             infront: (dx >= 0) === (me.facing === 'right'),
             aligned: Math.abs(dz) <= Z_TOLERANCE && Math.abs(dy) <= Y_TOLERANCE };
  };

  const threats = others.filter((f) => f.team !== me.team).map(geo)
    .sort((a, b) => a.range - b.range);
  // Read once here so the executor, the options and the log all mean the same
  // thing by "vulnerable" rather than each re-deriving it from the frame.
  for (const t of threats) {
    t.doing = doing(t);
    t.vulnerable = VULNERABLE.has(t.doing);
    // Whether the window is free or merely looks free: see HELPLESS.
    t.helpless = HELPLESS.has(t.doing);
    // Even level with us, a target lying on the floor or up in the air is below
    // or above a straight shot, so firing at it is MP spent on nothing.
    t.shootable = t.aligned && t.doing !== 'knocked_down' && t.doing !== 'in_the_air';
  }
  const allies = others.filter((f) => f.team === me.team).map(geo);

  const items = entities.filter((e) => ITEM_TYPES.has(e.type) && e.name !== 'broken_weapon')
    .map((e) => geo({ slot: e.slot, name: e.name, id: e.id, type: e.type, x: e.x, y: e.y, z: e.z }))
    .map((i) => ({ ...i, ...(motionTracker ? motionTracker(i) : { inFlight: false, closing: false }) }));

  const inHand = items.filter((i) => i.gap <= HELD_DX && i.zGap <= HELD_DZ);
  const held = (heldTracker ? inHand.find((i) => heldTracker(me, i)) : inHand[0]) ?? null;
  const ground = items.filter((i) => i !== held)
    .map((i) => ({ ...i, contested: others.some((o) => Math.hypot(o.x - i.x, o.z - i.z) < i.range) }))
    .sort((a, b) => a.range - b.range);

  // A thrown weapon is not a thing to walk over and pick up, and it is not a
  // thing to ignore either: it is the attack that lands most often. Closing
  // separates the one coming at us from the one we just threw ourselves.
  const flying = ground.filter((i) => i.inFlight && i.closing && i.range <= PROJECTILE_RANGE);

  return { me, threats, allies, held, items: ground, flying,
           nearest: threats[0]?.gap ?? Infinity };
}

/**
 * States that are a locked animation rather than a choice: the fighter cannot
 * move, block or attack for as long as they run. These are the punish windows —
 * `17` is drinking (`55:weapon_drink` in the data), and a fighter that stops to
 * drink is defenceless for seconds at a time.
 */
const LOCKED_STATES = {
  8: 'broken_guard',
  10: 'caught',
  13: 'frozen',
  15: 'throwing',
  17: 'drinking',
  18: 'burning',
};

/**
 * The subset of vulnerability that is genuinely unanswerable: a locked animation
 * cannot move, block or attack, so walking in and hitting it costs nothing.
 *
 * `recovering` is deliberately not in here. It means the enemy has no hitbox now
 * and none within the lookahead, which reads as a free hit but is also exactly
 * what the frame after releasing a thrown weapon looks like — the runs show the
 * damage arriving from the weapon while the fighter reads as recovering. Walking
 * in on that is a trade, not a punish, which is the distinction this set draws.
 */
export const HELPLESS = new Set(Object.values(LOCKED_STATES));

/** Doing values that mean the next moment is a free hit, or close to it. */
export const VULNERABLE = new Set([...HELPLESS, 'recovering']);

/** What a fighter is doing, read off its current frame rather than inferred. */
export function doing(f) {
  const frames = framesFor(f.id);
  const frame = frames?.[f.frame];
  if (!frame) return 'unknown';
  if (BUSY_STATES.has(frame.state)) return frame.state === 14 ? 'knocked_down' : 'staggered';
  if (frame.state === 7) return 'blocking';
  const hit = ticksToHit(frames, f.frame, f.waiting);
  if (hit === 0) return 'attacking';
  if (hit !== null) return 'winding_up_attack';
  // Attacking state with nothing live ahead is the recovery tail of a swing —
  // committed, unable to block, and the classic moment to be punished in.
  if (frame.state === 3) return 'recovering';
  if (LOCKED_STATES[frame.state]) return LOCKED_STATES[frame.state];
  if (frame.state === 2) return 'running';
  if (frame.state === 1) return 'walking';
  if (frame.state === 4) return 'in_the_air';
  return 'neutral';
}

const health = (f) => {
  const r = f.hp / (f.hpMax || 500);
  return r > 0.7 ? 'healthy' : r > 0.4 ? 'hurt' : r > 0.15 ? 'low' : 'critical';
};

const mana = (f) => {
  const r = f.mp / MP_CAP;
  return r > 0.8 ? 'full' : r > 0.5 ? 'plenty' : r > 0.25 ? 'some' : 'low';
};

/**
 * The state Jev sees. Nearest three threats only — the documented failure mode
 * is distraction by large irrelevant state, and the fourth enemy across the
 * stage has never changed an answer.
 */
export function semanticState({ arena, profile, recent = {} }) {
  const { me, threats, allies, held, items, flying } = arena;
  return {
    me: {
      character: me.name,
      archetype: profile?.archetype ?? 'unknown',
      hp: health(me),
      mp: mana(me),
      holding: held ? plainName(held.name) : 'none',
      stance: doing(me),
      facing: me.facing,
    },
    threats: threats.slice(0, 3).map((t) => ({
      id: `e${t.slot}`,
      distance: bucketRange(t.gap),
      side: t.infront ? 'front' : 'behind',
      line: t.aligned ? 'level with you' : (t.dz > 0 ? 'closer to the camera than you' : 'further back than you'),
      doing: t.doing,
      vulnerable: t.vulnerable,
      hp: health(t),
    })),
    // Things to walk over and take. A weapon in flight is not one of these, so
    // it is listed separately below rather than as a pickup.
    items: items.filter((i) => !i.inFlight).slice(0, 3).map((i) => ({
      what: plainName(i.name),
      kind: i.type === DRINK_TYPE ? 'drink' : 'weapon',
      distance: bucketRange(i.range),
      line: i.aligned ? 'level with you' : (i.dz > 0 ? 'closer to the camera than you' : 'further back than you'),
      contested: i.contested,
    })),
    // The things already travelling at us, which no amount of walking toward
    // them will answer.
    danger: flying.slice(0, 2).map((i) => ({
      what: plainName(i.name),
      distance: bucketRange(i.range),
      line: i.aligned ? 'on your line' : (i.dz > 0 ? 'crossing in front of you' : 'crossing behind you'),
    })),
    phase: {
      enemies_left: threats.length,
      allies: allies.length,
      ally_status: allies.length ? health(allies[0]) : 'none',
    },
    recent,
  };
}

export { DRINK_TYPE };
