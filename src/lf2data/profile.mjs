/**
 * Derives each character's fighting profile from the frame data.
 *
 * Strategy has to differ per character — an archer that walks into melee range
 * is playing itself badly — but the differences are already in the data, so
 * nothing here is hand-written per fighter. A move is ranged when its opoint
 * spawns an object that travels; its reach is how far its itr extends past the
 * sprite origin; its damage comes from its own itr or, for a projectile, from
 * the spawned object's.
 *
 * The output is what the executor turns into labelled options for Jev, and it
 * covers all 30-odd characters without a table of special cases.
 */

import { damagingItr, reachOfFrame } from './frames.mjs';

/** Distance buckets, in game units. Tuned to LF2's own numbers: a character is
 *  about 60 wide, a walk step ~5/tick, a dash covers ~150 before it lands. */
export const RANGE_BUCKETS = [
  { name: 'touching', max: 40 },
  { name: 'melee', max: 110 },
  { name: 'one_step', max: 220 },
  { name: 'one_dash', max: 420 },
  { name: 'far', max: Infinity },
];

export const bucketRange = (d) => RANGE_BUCKETS.find((b) => Math.abs(d) <= b.max).name;

/** Damage tiers, so Jev is given a word rather than a number to compare. */
export const DAMAGE_TIERS = [
  { name: 'chip', max: 20 },
  { name: 'light', max: 40 },
  { name: 'solid', max: 60 },
  { name: 'heavy', max: 90 },
  { name: 'huge', max: Infinity },
];

export const tierDamage = (n) => DAMAGE_TIERS.find((t) => n <= t.max).name;

/** MP tiers against the 500 bar the game uses. */
export const tierMp = (mp) =>
  mp === 0 ? 'free' : mp <= 50 ? 'cheap' : mp <= 150 ? 'moderate' : mp <= 300 ? 'expensive' : 'all_in';

/**
 * The basic attacks are not in `hit_*` — those fields only carry special moves,
 * and a character like Bandit has none at all. The engine reaches punches,
 * jump attacks and weapon swings by fixed entry frames instead, and the data
 * names every one of them, so the names are the lookup.
 */
export const BASIC_ATTACKS = {
  punch: { input: 'a', label: 'punch' },
  super_punch: { input: 'a', label: 'super_punch' },
  jump_attack: { input: 'j+a', label: 'jump_attack' },
  run_attack: { input: 'run+a', label: 'run_attack' },
  dash_attack: { input: 'dash+a', label: 'dash_attack' },
};

// No character frame carries a weapon's damage — a swing's frames hold no itr
// at all, and the hit comes from the weapon object's own `<wsl>` table. So what
// a weapon is worth is only knowable once one is in hand, which is why weapon
// options are built at run time from `build/_weapons.json` rather than baked
// into a character's profile.

/**
 * Furthest point an attack reaches ahead of the fighter, measured from the
 * fighter's own hurt box because `centerx` is absent on most frames.
 */
const reachOf = (frame) => Math.round(Math.max(0, reachOfFrame(frame)));

/** Walks a move's `next` chain, collecting reach, spawns and damage. */
function inspectMove(frames, entryId, isProjectile, maxDepth = 24) {
  let id = entryId;
  let ticks = 0;
  let mp = 0;
  let hpCost = 0;
  let allowedWhenShort = false;
  let reach = 0;
  const spawns = [];
  const visited = new Set();
  let injury = null;
  let landsOnFrame = null;

  for (let step = 0; step < maxDepth; step++) {
    const frame = frames.get(id);
    if (!frame || visited.has(id)) break;
    visited.add(id);
    // A negative cost is the engine's marker for a move that stays available
    // when MP runs short; the amount is still what it spends. Only the first
    // cost counts: a later one is the price of repeating the move, like the
    // 100 on 5_arrow's second frame, which `hit_a` loops back to (measured:
    // one volley spent about 130, not the 250 a sum gives).
    // Above 1000 the thousands carry an HP price: px.js takes `mp % 1000` MP
    // and `10 * floor(mp / 1000)` HP (Firen's explosion, 4300, is 300 MP and
    // 40 HP).
    if (typeof frame.mp === 'number' && mp === 0) {
      mp = Math.abs(frame.mp) % 1000;
      hpCost = 10 * Math.floor(Math.abs(frame.mp) / 1000);
      if (frame.mp < 0) allowedWhenShort = true;
    }

    for (const o of frame.opoint) {
      spawns.push({ oid: o.oid, action: o.action ?? 0, dvx: o.dvx ?? 0, dvy: o.dvy ?? 0 });
    }
    const hit = damagingItr(frame)[0];
    if (hit) {
      injury = hit.injury;
      reach = Math.max(reach, reachOf(frame));
      landsOnFrame = id;
      break;
    }
    // Only a spawn that hits ends the walk: Henry's blastpush puffs a harmless
    // cloud one frame before the wind that does the damage.
    if (spawns.some(isProjectile)) { landsOnFrame = id; break; }

    ticks += typeof frame.wait === 'number' ? frame.wait : 0;
    if (typeof frame.next !== 'number' || frame.next <= 0) break;
    id = frame.next;
  }
  return { mp, hpCost, allowedWhenShort, startupTicks: ticks, reach, spawns, injury, landsOnFrame };
}

/**
 * A `hit_*` field on a continuation frame is not a move you can start — it is
 * the next link in a chain the engine is already running. Davis's energy ball is
 * entered from standing by `hit_Fa` on frame 0; the rapid-fire tail `ball2..4`
 * lives on `hit_a` fields deep inside that chain, and reading those as separate
 * specials offers a move that can never be fired from neutral — its input is a
 * plain attack press with no defend to start it, so the executor sends keys
 * that do nothing and the option is a recorded no-op.
 *
 * So only transitions on frames reachable from neutral are entry moves: the
 * standing loop (`state` absent), walking (1), running (2) and defending (7).
 * Everything else — attacking (3), rowing (6), throwing (15), drinking (17) and
 * the rest — is a continuation. Verified across all characters: no root frame
 * carries a lowercase `hit_a`/`hit_j`/`hit_d`, so nothing legitimate is lost.
 */
const ENTRY_STATES = new Set([1, 2, 7]);
const isEntryFrame = (frame) => frame.state === undefined || ENTRY_STATES.has(frame.state);

/**
 * One character's profile.
 *
 * `objects` maps an object id to `{ type, damage, travels }` for everything a
 * move can spawn, which is what makes a projectile recognisable.
 */
export function buildProfile(name, frames, objects) {
  // What a spawn does depends on the frame it starts on: John's heal and his
  // energy ball are one object entered at different actions, and Rudolf's
  // transform smoke is Henry's wind entered at a harmless frame. A spawned
  // character (Rudolf's clones) is a summon, not a projectile.
  const spawnInfo = (s) => {
    const o = objects.get(s.oid);
    return { ...s, ...(o ?? {}), ...(o?.at?.(s.action) ?? {}) };
  };
  const isProjectile = (s) => s.type !== 0 && s.damage > 0;
  const moves = [];
  const seen = new Set();

  /** Special moves from `hit_*`, then the engine's named basic attacks. */
  const entries = [];
  for (const frame of frames.values()) {
    if (!isEntryFrame(frame)) continue;
    for (const [input, target] of Object.entries(frame.transitions)) entries.push([input, target, 'special']);
  }
  for (const frame of frames.values()) {
    const basic = frame.name && BASIC_ATTACKS[frame.name];
    if (basic) entries.push([basic.input, frame.id, 'basic', basic]);
  }

  {
    for (const [input, target, category, basic] of entries) {
      const key = `${input}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const m = inspectMove(frames, target, (s) => isProjectile(spawnInfo(s)));
      const projectiles = m.spawns.map(spawnInfo).filter(isProjectile);
      const damage = m.injury ?? (projectiles.length ? Math.max(...projectiles.map((p) => p.damage ?? 0)) : null);
      if ((damage === null || damage === 0) && projectiles.length === 0) continue;

      moves.push({
        input,
        entry: target,
        category,
        name: basic?.label ?? frames.get(target)?.name ?? null,
        needsWeapon: basic?.needsWeapon ?? false,
        kind: projectiles.length > 0 ? 'ranged' : 'melee',
        mp: m.mp,
        hpCost: m.hpCost,
        mpTier: tierMp(m.mp),
        allowedWhenShort: m.allowedWhenShort,
        startupTicks: m.startupTicks,
        reach: projectiles.length > 0 ? null : m.reach,
        rangeBucket: projectiles.length > 0 ? 'far' : bucketRange(m.reach),
        damage,
        damageTier: damage ? tierDamage(damage) : null,
        spawns: projectiles.map((p) => p.oid),
      });
    }
  }

  moves.sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0));
  const ranged = moves.filter((m) => m.kind === 'ranged');
  const melee = moves.filter((m) => m.kind === 'melee');
  const bare = melee.filter((m) => !m.needsWeapon);

  /**
   * What the plain attack button does from standing. This is the one fact that
   * decides how the character wants to fight: Henry's punch fires an arrow, so
   * he has no reason to close distance, while Bandit's punch is a punch.
   */
  const basicAttack = moves.find((m) => m.category === 'basic' && m.name === 'punch')
    ?? moves.find((m) => m.category === 'basic' && !m.needsWeapon);

  return {
    name,
    moves,
    archetype: basicAttack?.kind === 'ranged' ? 'ranged'
      : ranged.length > 0 ? 'mixed'
      : 'melee',
    basicAttack: basicAttack ?? null,
    hasRanged: ranged.length > 0,
    cheapestRangedMp: ranged.length ? Math.min(...ranged.map((m) => m.mp)) : null,
    /** Furthest a bare-handed attack reaches, which sets the melee stand-off. */
    meleeReach: bare.length ? Math.max(...bare.map((m) => m.reach)) : 0,
    bestMelee: bare[0] ?? null,
    bestRanged: ranged[0] ?? null,
  };
}

/**
 * Damage and travel from one frame of an object onward, following `next`.
 * An opoint names the frame a spawn starts on, and one object file often holds
 * several unrelated things.
 */
function fromAction(frames, action, maxDepth = 40) {
  let damage = 0;
  let moving = false;
  const seen = new Set();
  for (let id = action, step = 0; step < maxDepth && frames.has(id) && !seen.has(id); step++) {
    seen.add(id);
    const f = frames.get(id);
    for (const it of damagingItr(f)) damage = Math.max(damage, it.injury);
    if (Math.abs(f.dvx ?? 0) > 0) moving = true;
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) break;
    id = f.next;
  }
  return { damage, travels: moving && damage > 0 };
}

/** Everything a move can spawn, keyed by object id. */
export function buildObjectIndex(parsedById) {
  const objects = new Map();
  for (const [id, { header, frames }] of parsedById) {
    let damage = 0;
    let moving = false;
    for (const f of frames.values()) {
      for (const it of damagingItr(f)) damage = Math.max(damage, it.injury);
      if (Math.abs(f.dvx ?? 0) > 0) moving = true;
    }
    objects.set(id, {
      name: header.name ?? null,
      type: header.type ?? null,
      damage,
      /** A projectile is an object that carries itself across the screen. */
      travels: moving && damage > 0,
      /** Not serialized: the same facts from one starting frame. */
      at: (action) => (frames.has(action) ? fromAction(frames, action) : null),
    });
  }
  return objects;
}
