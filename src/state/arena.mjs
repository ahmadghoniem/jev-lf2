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
 * A weapon in hand sits at its holder's exact depth and rides along with it,
 * while a weapon on the ground keeps its own. Unverified against a field that
 * states the link outright — logged on every tick so a recording can settle it.
 */
const HELD_DX = 45;
const HELD_DZ = 2;

/**
 * `human` is the reliable way to find our own fighter, and the only one that
 * survives Phase 1: Jev and a COM playing the *same character* means the name
 * matches two entities. An explicit slot wins over it; the name is a last
 * resort for a run where no slot is human-controlled.
 */
export function readArena(entities, { slot, name } = {}) {
  const fighters = entities.filter((e) => e.type === 0).map(readFighter);
  const me = (slot !== undefined && fighters.find((f) => f.slot === slot))
    || fighters.find((f) => f.human)
    || (name && fighters.find((f) => f.name?.toLowerCase() === name.toLowerCase()));
  if (!me) return null;

  const others = fighters.filter((f) => f !== me && f.alive);
  const geo = (e) => {
    const dx = e.x - me.x;
    const dz = e.z - me.z;
    return { ...e, dx, dz, gap: Math.abs(dx), zGap: Math.abs(dz), range: Math.hypot(dx, dz),
             side: dx >= 0 ? 'right' : 'left',
             infront: (dx >= 0) === (me.facing === 'right') };
  };

  const threats = others.filter((f) => f.team !== me.team).map(geo)
    .sort((a, b) => a.range - b.range);
  const allies = others.filter((f) => f.team === me.team).map(geo);

  const items = entities.filter((e) => ITEM_TYPES.has(e.type) && e.name !== 'broken_weapon')
    .map((e) => geo({ slot: e.slot, name: e.name, id: e.id, type: e.type, x: e.x, y: e.y, z: e.z }));

  const held = items.find((i) => i.gap <= HELD_DX && i.zGap <= HELD_DZ) ?? null;
  const ground = items.filter((i) => i !== held)
    .map((i) => ({ ...i, contested: others.some((o) => Math.hypot(o.x - i.x, o.z - i.z) < i.range) }))
    .sort((a, b) => a.range - b.range);

  return { me, threats, allies, held, items: ground, nearest: threats[0]?.gap ?? Infinity };
}

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
  const { me, threats, allies, held, items } = arena;
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
      doing: doing(t),
      hp: health(t),
    })),
    items: items.slice(0, 3).map((i) => ({
      what: plainName(i.name),
      kind: i.type === DRINK_TYPE ? 'drink' : 'weapon',
      distance: bucketRange(i.range),
      contested: i.contested,
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
