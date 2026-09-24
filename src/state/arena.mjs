/**
 * Turns a pool read into the view everything else works from.
 *
 * Two shapes come out of here. The *arena* is numeric and is what the executor
 * and the reflexes use — distances, who is where, what is in hand. The
 * *semantic state* is what Jev sees, and it carries no raw numbers at all,
 * because Jev is documented as unreliable at comparing them and there is no
 * reason to make it try.
 */

import { readFighter, MP_CAP, mpRegenPerSecond } from './fields.mjs';
import { framesFor, BUSY_STATES } from '../lf2data/tables.mjs';
import { ticksToHit } from '../lf2data/frames.mjs';
import { bucketRange } from '../lf2data/profile.mjs';
import { plainName } from './options.mjs';

/** Data-file types that can be picked up. 6 is milk and beer. */
const ITEM_TYPES = new Set([1, 2, 4, 6]);
export const DRINK_TYPE = 6;

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
/**
 * How long a weapon stays flagged as flying once it has been seen moving.
 *
 * The motion read is noisy in exactly the wrong place: a returning weapon's
 * range oscillates between reads (46→57→46), so `moved` can dip under the slack
 * in mid-flight and the flag drops for a tick or two. Every such gap is a tick
 * with no dodge, and the run data shows the worst of them land a stale answer
 * into an arriving weapon. So flight is sticky: seeing a weapon move keeps it
 * flagged for this many reads even if the next read shows little movement.
 */
const FLIGHT_STICKY = 10;
/**
 * How far away a weapon can be and still make the flying list. The old 110 only
 * saw a weapon once it was almost here, which is why the dodge never had time.
 * The CPU steps when a projectile is 150 away; the horizon has to be at least
 * that, with room for the dodge to finish its step before arrival.
 */
const PROJECTILE_RANGE = 200;
/**
 * Farther than any weapon travels between two reads. The game recycles pool
 * slots, so a new arrow or shuriken appears in the slot of one that vanished
 * elsewhere, and compared with that old position it reads as a weapon that just
 * closed hundreds of units in one tick. Every Henry shot was read that way: his
 * own arrow, leaving at 22 a read, came out as inbound at speed 385 and the
 * dodge fired after every shot.
 */
const RESPAWN_JUMP = 120;
/**
 * The slowest a thrown weapon closes, in units per read; Rudolf's shuriken
 * does 15-19 and an arrow 22. A weapon on the ground that the stage nudges, or
 * one we are walking toward, closes at 2-5 and was being dodged "45 ticks out".
 */
const MIN_THROWN_SPEED = 8;

export function createItemMotion({ slack = FLIGHT_SLACK, stickyTicks = FLIGHT_STICKY } = {}) {
  const prev = new Map();
  const prev2 = new Map();   // the position two reads back, for a stable `closing`
  const sticky = new Map();
  const prevOffset = new Map(); // this weapon's offset to the nearest fighter
  const speeds = new Map();     // the last few closing speeds, for `pace`
  return (item, fighters = []) => {
    const now = { x: Math.round(item.x), z: Math.round(item.z), range: item.range };
    let was = prev.get(item.slot);
    const left = sticky.get(item.slot) ?? 0;
    // Launched: it reappeared somewhere else, or it was lying still and is now
    // moving. Either way the previous read says nothing about which way it is
    // going — an arrow recycled into the slot of one lying 28 units further
    // out read as closing on us at 28 a read.
    const jump = was ? Math.hypot(now.x - was.x, now.z - was.z) : 0;
    const launched = !!was && (jump > RESPAWN_JUMP || (left === 0 && jump > slack));
    if (launched) { was = undefined; prevOffset.delete(item.slot); speeds.delete(item.slot); }
    const was2 = launched ? undefined : prev2.get(item.slot);
    prev2.set(item.slot, was ?? now);
    prev.set(item.slot, now);

    // A weapon a fighter is holding moves exactly with that fighter: its offset
    // to the nearest one stays small and barely changes between reads. A thrown
    // weapon's offset to everyone changes at its own speed. This is the
    // difference the motion read could not make on its own, and the run data
    // shows what the miss cost: an enemy's held weapon swaying with its idle
    // animation passed every flight test, the dodge fired at it for 27 ticks
    // while it sat at our feet doing nothing, and every attack was refused in
    // that window because the lane looked occupied.
    const near = fighters.length
      ? fighters.reduce((best, f) => {
          const d = Math.hypot(f.x - item.x, f.z - item.z);
          return !best || d < best.d
            ? { d, dx: Math.round(item.x - f.x), dz: Math.round(item.z - f.z) } : best;
        }, null)
      : null;
    const wasOffset = prevOffset.get(item.slot);
    prevOffset.set(item.slot, near);
    const carried = !!near && near.d < 60 && !!wasOffset
      && Math.abs(wasOffset.dx - near.dx) <= 8 && Math.abs(wasOffset.dz - near.dz) <= 8;

    // A launched weapon is in the air, but which way it is going is only known
    // from the next read. Our own arrow then reads as leaving and is never a
    // threat; nothing else is needed to tell whose it is.
    if (launched) {
      sticky.set(item.slot, stickyTicks);
      return { inFlight: !carried, closing: false, speed: 0, pace: 0, carried };
    }
    if (!was) return { inFlight: left > 0, closing: false, speed: 0, pace: 0, carried };
    const fresh = jump > slack;
    sticky.set(item.slot, fresh ? stickyTicks : Math.max(0, left - 1));
    // The fastest it has closed over the last three reads: a weapon pausing
    // mid-flight keeps its pace, a weapon crawling never gets one.
    const recent = [...(speeds.get(item.slot) ?? []), was.range - now.range].slice(-3);
    speeds.set(item.slot, recent);
    return { inFlight: (fresh || sticky.get(item.slot) > 0) && !carried,
             // Closing across two reads, and inclusive: a weapon pausing
             // mid-flight (its range read the same twice in a row) is still
             // coming, and a strict `<` dropped the flag on exactly those
             // reads — which is what released the dodge a tick early.
             closing: now.range <= was.range || now.range <= (was2?.range ?? now.range),
             // Units closed per read, which is what turns distance into time.
             speed: was.range - now.range,
             pace: Math.max(...recent),
             carried };
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
/**
 * The view is LF2's 794 units wide and follows the human player, clamped at the
 * stage ends. A fighter whose body is past its edge is off the screen, which is
 * also where the observer saw Henry's shots go nowhere: every "enemy not on
 * screen" note of 2026-09-23 had Rudolf 398 or more from Henry. The margin
 * keeps half a body inside.
 */
export const VIEW_HALF = 397;
const ON_SCREEN_MARGIN = 30;

export function readArena(entities, { slot, name, isLive, heldTracker, motionTracker,
                                      stageWidth = Infinity } = {}) {
  const fighters = entities.filter((e) => e.type === 0).map(readFighter);
  const me = (slot !== undefined && fighters.find((f) => f.slot === slot))
    || fighters.find((f) => f.human)
    || (name && fighters.find((f) => f.name?.toLowerCase() === name.toLowerCase()));
  if (!me) return null;

  // Our own fighter is never liveness-checked: lying dead is motionless, and
  // dropping ourselves would end the run.
  const others = fighters.filter((f) => f !== me && f.alive && (!isLive || isLive(f)));
  const cameraX = Math.min(Math.max(me.x, VIEW_HALF), Math.max(VIEW_HALF, stageWidth - VIEW_HALF));
  const geo = (e) => {
    const dx = e.x - me.x;
    const dz = e.z - me.z;
    const dy = e.y - me.y;
    // The CPU writes where it means to walk to; -1000 is its "no destination"
    // marker, and only a fighter type carries the fields at all. This is the
    // enemy's own intent, read rather than guessed from its motion.
    const hasDest = Number.isFinite(e.destX) && Number.isFinite(e.destZ)
      && e.destX > -999 && e.destZ > -999;
    const destDx = hasDest ? e.destX - me.x : null;
    const destDz = hasDest ? e.destZ - me.z : null;
    return { ...e, dx, dz, dy, gap: Math.abs(dx), zGap: Math.abs(dz), yGap: Math.abs(dy),
             range: Math.hypot(dx, dz),
             side: dx >= 0 ? 'right' : 'left',
             infront: (dx >= 0) === (me.facing === 'right'),
             aligned: Math.abs(dz) <= Z_TOLERANCE && Math.abs(dy) <= Y_TOLERANCE,
             hasDest, destDx, destDz,
             onScreen: Math.abs(e.x - cameraX) <= VIEW_HALF - ON_SCREEN_MARGIN,
             // A destination nearer to us than where it stands means it is
             // closing; farther away means it is withdrawing or holding.
             approach: hasDest && Math.abs(destDx) < Math.abs(dx) };
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
  }
  const allies = others.filter((f) => f.team === me.team).map(geo);

  const items = entities.filter((e) => ITEM_TYPES.has(e.type) && e.name !== 'broken_weapon')
    .map((e) => geo({ slot: e.slot, name: e.name, id: e.id, type: e.type, x: e.x, y: e.y, z: e.z }))
    // Every fighter is handed in, because the carried test needs the holder:
    // the same read that says "this weapon moved" has to be able to say "but it
    // moved with the fighter standing next to it".
    .map((i) => ({ ...i, ...(motionTracker
      ? motionTracker(i, [me, ...others])
      : { inFlight: false, closing: false, carried: false }) }))
    // In the air, loose and coming our way at a thrown weapon's speed: the one
    // test every consumer means by "a thrown weapon".
    .map((i) => ({ ...i, hostile: i.inFlight && !i.carried && i.closing
      && (i.pace ?? 0) >= MIN_THROWN_SPEED }));

  const inHand = items.filter((i) => i.gap <= HELD_DX && i.zGap <= HELD_DZ);
  const held = (heldTracker ? inHand.find((i) => heldTracker(me, i)) : inHand[0]) ?? null;
  const ground = items.filter((i) => i !== held)
    .map((i) => ({ ...i, contested: others.some((o) => Math.hypot(o.x - i.x, o.z - i.z) < i.range) }))
    .sort((a, b) => a.range - b.range);

  // A thrown weapon is not a thing to walk over and pick up, and it is not a
  // thing to ignore either: it is the attack that lands most often. A weapon
  // carried in a hand is neither, whatever its idle sway looks like in the
  // motion read.
  const flying = ground.filter((i) => i.hostile && i.range <= PROJECTILE_RANGE);

  return { me, threats, allies, held, items: ground, flying, stageWidth,
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
const HELPLESS = new Set(Object.values(LOCKED_STATES));

/** Doing values that mean the next moment is a free hit, or close to it. */
const VULNERABLE = new Set([...HELPLESS, 'recovering']);

/**
 * Whether a shot or swing started now cannot land. A fighter on the floor is
 * below anything fired or swung from standing. A jump is over in about 20
 * ticks, so from further off a shot arrives after the landing; treating every
 * jump as down held Henry's specials while Rudolf hopped 200-380 away, which
 * the observer saw as passing up open chances.
 */
export const JUMP_CLEAR_GAP = 200;
export const unhittable = (t) => !!t && (t.doing === 'knocked_down'
  || (t.doing === 'in_the_air' && t.gap < JUMP_CLEAR_GAP));

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

/** Where something sits in depth relative to us, in words. */
const depthOf = (e, level, nearer, further) => (e.aligned ? level : e.dz > 0 ? nearer : further);

const health = (f) => {
  const r = f.hp / (f.hpMax || 500);
  return r > 0.7 ? 'healthy' : r > 0.4 ? 'hurt' : r > 0.15 ? 'low' : 'critical';
};

/**
 * The bar in numbers rather than a tier: "some" could not tell Jev whether a
 * 200 MP special was affordable. The refill is stated because a full bar does
 * not store more, so MP held back at the cap is refill thrown away.
 */
const mana = (f) => {
  const mp = Math.min(f.mp, MP_CAP);
  const full = mp >= MP_CAP - 20 ? ', full, so the refill is being wasted until you spend some' : '';
  return `${mp} of ${MP_CAP}, refilling about ${mpRegenPerSecond(f.hp)} a second${full}`;
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
      line: depthOf(t, 'level with you', 'closer to the camera than you', 'further back than you'),
      doing: t.doing,
      vulnerable: t.vulnerable,
      hp: health(t),
      // Where it is heading, not where it is. Only a COM has a destination to
      // read; a human-controlled fighter leaves this null.
      heading: t.hasDest ? (t.approach ? 'closing on you' : 'withdrawing or holding') : null,
    })),
    // Things to walk over and take. A weapon in flight is not one of these, so
    // it is listed separately below rather than as a pickup.
    items: items.filter((i) => !i.inFlight).slice(0, 3).map((i) => ({
      what: plainName(i.name),
      kind: i.type === DRINK_TYPE ? 'drink' : 'weapon',
      distance: bucketRange(i.range),
      line: depthOf(i, 'level with you', 'closer to the camera than you', 'further back than you'),
      contested: i.contested,
    })),
    // The things already travelling at us, which no amount of walking toward
    // them will answer.
    danger: flying.slice(0, 2).map((i) => ({
      what: plainName(i.name),
      distance: bucketRange(i.range),
      line: depthOf(i, 'on your line', 'crossing in front of you', 'crossing behind you'),
    })),
    phase: {
      enemies_left: threats.length,
      allies: allies.length,
      ally_status: allies.length ? health(allies[0]) : 'none',
    },
    recent,
  };
}
