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
  let fall = 0;
  let bdefend = 0;
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
      fall = hit.fall ?? 0;
      bdefend = hit.bdefend ?? 0;
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
  return { mp, hpCost, allowedWhenShort, startupTicks: ticks, reach, spawns, injury, fall, bdefend, landsOnFrame };
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
/**
 * Reach measured in play, for projectiles whose data cannot give it. Henry's
 * arrow is a thrown object that drops under gravity, so its frame chain loops
 * and reads as flying until it hits. Over every Henry vs Rudolf run of
 * 2026-09-23 it landed 57% of the time from 100 to 499 away and 24% from 500
 * to 599; Rudolf drank 510-600 away through 55 ticks of arrows and lost no HP.
 */
const MEASURED_RANGE = { henry_arrow1: 500 };

export function buildProfile(name, frames, objects) {
  // What a spawn does depends on the frame it starts on: John's heal and his
  // energy ball are one object entered at different actions, and Rudolf's
  // transform smoke is Henry's wind entered at a harmless frame. A spawned
  // character (Rudolf's clones) is a summon, not a projectile.
  const spawnInfo = (s) => {
    const o = objects.get(s.oid);
    const info = { ...s, ...(o ?? {}), ...(o?.at?.(s.action) ?? {}) };
    const measured = MEASURED_RANGE[o?.name];
    if (measured && !info.falloff && info.damage > 0) {
      info.range = measured;
      info.falloff = [{ to: measured, injury: info.damage }];
    }
    return info;
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
        // What a hit does besides damage, read the way px.js applies it. A hit
        // lands through a block when its bdefend is over 60 (100 always does).
        // The fall value adds up and a fighter goes down past 60: the plain
        // arrow's 60 put Rudolf down on 14 of 36 hits, the ones that landed on
        // an earlier hit, while a single hit over 60 floors a fresh fighter.
        knocksDown: hitFall(m, projectiles) > 60,
        breaksGuard: hitBdefend(m, projectiles) > 60,
        // Some projectiles are short-lived and weaken as they go — Henry's
        // blastpush is 80 up close and gone past about 600 — where others fly
        // until they hit. Null for a melee move and for a projectile that keeps
        // its hit at any distance.
        ...projectileRange(projectiles),
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
  let fall = 0;
  let bdefend = 0;
  let moving = false;
  // How the hit changes with distance. Each frame carries the ball `wait`
  // ticks at its own `dvx`, so the chain is a list of distance bands. A chain
  // that ends on 1000 is gone at the last band; one that loops (999, or back to
  // a frame already seen) flies until it hits, and has no range.
  // Checked against Henry's blastpush in the 2026-09-23 runs: 80 at 50-249,
  // 55 at 250-299 and 20 at 400-449, where the bands give 80 to 220, 55 to
  // 385 and 20 to 495.
  const falloff = [];
  let travelled = 0;
  let range = null;
  const seen = new Set();
  for (let id = action, step = 0; step < maxDepth && frames.has(id) && !seen.has(id); step++) {
    seen.add(id);
    const f = frames.get(id);
    let injury = 0;
    for (const it of damagingItr(f)) {
      injury = Math.max(injury, it.injury);
      damage = Math.max(damage, it.injury);
      fall = Math.max(fall, it.fall ?? 0);
      bdefend = Math.max(bdefend, it.bdefend ?? 0);
    }
    if (Math.abs(f.dvx ?? 0) > 0) moving = true;
    travelled += Math.abs(f.dvx ?? 0) * (f.wait ?? 0);
    const last = falloff.at(-1);
    if (last && last.injury === injury) last.to = travelled;
    else falloff.push({ to: travelled, injury });
    if (f.next === 1000) { range = travelled; break; }
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) break;
    id = f.next;
  }
  // Under 100 of travel the thing is placed, not thrown — Firen's and Julian's
  // explosions stand still, Firen's flame is a trail laid while he runs — and
  // where it lands depends on the caster, so no distance band describes it.
  const finite = range !== null && range >= 100 && damage > 0;
  return { damage, fall, bdefend, travels: moving && damage > 0,
           range: finite ? Math.round(range) : null,
           falloff: finite ? falloff.filter((b) => b.injury > 0).map((b) => ({ to: Math.round(b.to), injury: b.injury })) : null };
}

/** A projectile's damage at a distance: its full hit if it has no range. */
export function damageAt(move, distance) {
  if (!move.falloff) return move.damage;
  return move.falloff.find((b) => distance <= b.to)?.injury ?? 0;
}

/** The strongest projectile's range and damage bands, or none if any flies on. */
function projectileRange(projectiles) {
  if (!projectiles.length || projectiles.some((p) => !p.falloff)) return { range: null, falloff: null };
  const best = projectiles.reduce((a, b) => ((b.damage ?? 0) > (a.damage ?? 0) ? b : a));
  return { range: best.range, falloff: best.falloff };
}

const hitFall = (m, projectiles) => (m.injury != null ? m.fall
  : Math.max(0, ...projectiles.map((p) => p.fall ?? 0)));
const hitBdefend = (m, projectiles) => (m.injury != null ? m.bdefend
  : Math.max(0, ...projectiles.map((p) => p.bdefend ?? 0)));

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
