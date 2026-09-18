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

/**
 * No character frame carries a weapon's damage — a swing's frames hold no itr
 * at all, and the hit comes from the weapon object's own `<wsl>` table. So what
 * a weapon is worth is only knowable once one is in hand, which is why weapon
 * options are built at run time from `build/_weapons.json` rather than baked
 * into a character's profile.
 */
export const WEAPON_ATTACK_FRAMES = {
  20: 'weapon_attack', 30: 'weapon_jump_attack', 35: 'weapon_run_attack',
  40: 'weapon_dash_attack', 45: 'weapon_throw', 50: 'heavy_weapon_throw',
};

/**
 * itr kinds that actually hurt someone. `kind 0` is an ordinary attack and
 * `kind 6` a super punch; `kind 2` is the pick-up box and `kind 5` marks a
 * weapon's in-hand strength, whose `injury 789` is a placeholder the engine
 * replaces from the weapon's `<wsl>` table. Counting those as damage reads an
 * arrow as an 789-point attack.
 */
const HURTS = new Set([0, 6]);
const damagingItr = (frame) => frame.itr.filter((it) => HURTS.has(it.kind) && it.injury > 0);


/**
 * Furthest point an attack reaches ahead of the fighter.
 *
 * `centerx` is absent on most frames, so the fighter's own hurt box gives the
 * origin: its middle is where the character stands.
 */
function reachOf(frame) {
  const itrs = damagingItr(frame);
  const origin = typeof frame.centerx === 'number'
    ? frame.centerx
    : frame.bdy.length
      ? frame.bdy[0].x + frame.bdy[0].w / 2
      : 0;
  let reach = 0;
  for (const itr of itrs) {
    reach = Math.max(reach, (itr.x ?? 0) + (itr.w ?? 0) - origin);
  }
  return Math.round(reach);
}

/** Walks a move's `next` chain, collecting reach, spawns and damage. */
function inspectMove(frames, entryId, maxDepth = 24) {
  let id = entryId;
  let ticks = 0;
  let mp = 0;
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
    // when MP runs short; the amount is still what it spends.
    if (typeof frame.mp === 'number') {
      mp += Math.abs(frame.mp);
      if (frame.mp < 0) allowedWhenShort = true;
    }

    for (const o of frame.opoint) {
      spawns.push({ oid: o.oid, dvx: o.dvx ?? 0, dvy: o.dvy ?? 0, count: o.action != null ? 1 : 1 });
    }
    const hit = damagingItr(frame)[0];
    if (hit) {
      injury = hit.injury;
      reach = Math.max(reach, reachOf(frame));
      landsOnFrame = id;
      break;
    }
    if (spawns.some((s) => s.dvx !== 0 || s.dvy !== 0)) { landsOnFrame = id; break; }

    ticks += typeof frame.wait === 'number' ? frame.wait : 0;
    if (typeof frame.next !== 'number' || frame.next <= 0) break;
    id = frame.next;
  }
  return { mp, allowedWhenShort, startupTicks: ticks, reach, spawns, injury, landsOnFrame };
}

/**
 * One character's profile.
 *
 * `objects` maps an object id to `{ type, damage, travels }` for everything a
 * move can spawn, which is what makes a projectile recognisable.
 */
export function buildProfile(name, frames, objects) {
  const moves = [];
  const seen = new Set();

  /** Special moves from `hit_*`, then the engine's named basic attacks. */
  const entries = [];
  for (const frame of frames.values()) {
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

      const m = inspectMove(frames, target);
      const spawned = m.spawns.map((s) => ({ ...s, ...(objects.get(s.oid) ?? {}) }));
      const projectiles = spawned.filter((s) => s.travels || s.dvx !== 0);
      const damage = m.injury ?? (projectiles.length ? Math.max(...projectiles.map((p) => p.damage ?? 0)) : null);
      if (damage === null && projectiles.length === 0) continue;

      moves.push({
        input,
        entry: target,
        category,
        name: basic?.label ?? frames.get(target)?.name ?? null,
        needsWeapon: basic?.needsWeapon ?? false,
        kind: projectiles.length > 0 ? 'ranged' : 'melee',
        mp: m.mp,
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
    });
  }
  return objects;
}
