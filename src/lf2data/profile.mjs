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
import { BOT } from '../state/bot.mjs';

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
  // A frame lasts wait + 1 ticks (px.js moves on once `waiting > wait`), so
  // this is when the hit or the shot really starts: Dennis's chase ball
  // leaves 9 ticks in, measured 265 ms from its first frame over 48 casts.
  let hitTicks = 0;
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
      // A `facing` of 10 or more spawns floor(facing / 10) copies (px.js).
      spawns.push({ oid: o.oid, action: o.action ?? 0, dvx: o.dvx ?? 0, dvy: o.dvy ?? 0,
                    count: (o.facing ?? 0) >= 10 ? Math.floor(o.facing / 10) : 1 });
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
    hitTicks += (typeof frame.wait === 'number' ? frame.wait : 0) + 1;
    if (typeof frame.next !== 'number' || frame.next <= 0) break;
    id = frame.next;
  }
  return { mp, hpCost, allowedWhenShort, startupTicks: ticks, hitTicks, reach, spawns, injury, fall, bdefend, landsOnFrame };
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
 * By 50-unit band over 34 runs it lands 55-70% of the time from 50 to 449 and
 * 43% from 450 to 499, so its reach is taken as 450.
 */
const MEASURED_RANGE = { henry_arrow1: 450 };
/**
 * Ticks a steering ball takes from its spawn to the hit, measured in play: the
 * engine steers it, so no frame says how fast it goes. Dennis's chasing ball
 * starts at 3 a tick and turns after its target; from its first frame it hit
 * after a median 21 ticks at every distance (20 under 150, 24 at 300-450, 436
 * hits since 2026-09-20; scratch/ball-arrival.mjs), 6 of them before the spawn.
 */
const MEASURED_FLIGHT = { dennis_chase: 15 };

export function buildProfile(name, frames, objects) {
  // What a spawn does depends on the frame it starts on: John's heal and his
  // energy ball are one object entered at different actions, and Rudolf's
  // transform smoke is Henry's wind entered at a harmless frame. A spawned
  // character (Rudolf's clones) is a summon, not a projectile.
  const spawnInfo = (s) => {
    const o = objects.get(s.oid);
    const info = { ...s, ...(o ?? {}), ...(o?.at?.(s.action) ?? {}) };
    if (o?.chasesAt?.(s.action)) info.homes = true;
    info.speed = Math.max(info.speed ?? 0, Math.abs(s.dvx ?? 0)) || null;
    if (info.homes && MEASURED_FLIGHT[o?.name]) info.flightTicks = MEASURED_FLIGHT[o.name];
    if (!(info.damage > 0) && o?.hiddenAt) {
      const hidden = o.hiddenAt(s.action);
      if (hidden > 0) Object.assign(info, { damage: hidden, range: null, falloff: null });
    }
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

      let m = inspectMove(frames, target, (s) => isProjectile(spawnInfo(s)));
      let projectiles = m.spawns.map(spawnInfo).filter(isProjectile).map(fanned);
      let damage = m.injury ?? (projectiles.length ? Math.max(...projectiles.map((p) => p.damage ?? 0)) : null);
      let followUp = null;
      let effect = null;
      const chain = chainFrom(frames, target);
      if ((damage === null || damage === 0) && projectiles.length === 0) {
        if (category !== 'special') continue;
        // Some specials end on a frame that waits for Attack to go on (Davis's
        // and Deep's jump into a hit): the hit is behind that press.
        const next = chain.at(-1)?.transitions?.a;
        const after = next != null ? inspectMove(frames, next, (s) => isProjectile(spawnInfo(s))) : null;
        const afterShots = after ? after.spawns.map(spawnInfo).filter(isProjectile).map(fanned) : [];
        if (after && (after.injury > 0 || afterShots.length)) {
          m = { ...after, mp: m.mp || after.mp, hpCost: m.hpCost || after.hpCost,
                allowedWhenShort: m.allowedWhenShort, startupTicks: m.startupTicks + after.startupTicks,
                hitTicks: m.hitTicks + after.hitTicks };
          projectiles = afterShots;
          damage = after.injury ?? Math.max(...afterShots.map((p) => p.damage ?? 0));
          followUp = ['attack'];
        } else {
          // Every special is kept: one the data shows no hit for is offered by
          // what it does instead (heal, teleport, clone...).
          effect = effectOf(chain, chain.flatMap((f) => f.opoint ?? []).map((o) => objects.get(o.oid)));
        }
      }
      if (effect === 'grab') {
        const box = chain.flatMap((f) => (f.itr ?? []).filter((it) => it.kind === 3).map((it) => ({ f, it })))[0];
        m = { ...m, reach: box ? Math.round(Math.max(0, (box.it.x ?? 0) + (box.it.w ?? 0) - (box.f.centerx ?? 0))) : 0 };
      }

      moves.push({
        input,
        entry: target,
        category,
        name: basic?.label ?? frames.get(target)?.name ?? null,
        needsWeapon: basic?.needsWeapon ?? false,
        kind: effect ? 'utility' : projectiles.length > 0 ? 'ranged' : 'melee',
        effect,
        followUp,
        mp: m.mp,
        hpCost: m.hpCost,
        mpTier: tierMp(m.mp),
        allowedWhenShort: m.allowedWhenShort,
        startupTicks: m.startupTicks,
        hitTicks: m.hitTicks,
        reach: projectiles.length > 0 ? null : m.reach,
        rangeBucket: projectiles.length > 0 ? 'far' : bucketRange(m.reach ?? 0),
        damage,
        damageTier: damage ? tierDamage(damage) : null,
        // What a hit does besides damage, read the way px.js applies it. A hit
        // lands through a block when its bdefend is over 60 (100 always does).
        // The fall value adds up and a fighter goes down past 60: the plain
        // arrow's 60 put Rudolf down on 14 of 36 hits, the ones that landed on
        // an earlier hit, while a single hit over 60 floors a fresh fighter.
        knocksDown: hitFall(m, projectiles) > 60,
        // The fall the first hit adds, 0 counting as 20 the way px.js adds it.
        // It decides whether a hit on a fighter in the dance of pain knocks it
        // down (see `painText` in options.mjs).
        fall: damage ? hitFall(m, projectiles) || 20 : null,
        breaksGuard: hitBdefend(m, projectiles) > 60,
        // What a blocked hit adds to the guard meter (see `guardText` in
        // options.mjs).
        bdefend: damage ? hitBdefend(m, projectiles) : null,
        // Some projectiles are short-lived and weaken as they go — Henry's
        // blastpush is 80 up close and gone past about 600 — where others fly
        // until they hit. Null for a melee move and for a projectile that keeps
        // its hit at any distance.
        ...projectileRange(projectiles),
        // A chasing ball steers to its target, so it needs no lining up: Dennis
        // chose his three times against a Freeze walking off his line and each
        // was replaced while he was still walking to it (2026-09-25T10-33-30).
        homes: projectiles.some((p) => p.homes),
        // How fast the strongest shot flies, a tick, or for a steering one the
        // ticks it was measured to take (MEASURED_FLIGHT); the options turn
        // either into the time to reach the enemy.
        ...flightOf(projectiles),
        volley: projectiles.length > 0 ? volleyOf(frames, target, spawnInfo, isProjectile) : null,
        spawns: projectiles.map((p) => p.oid),
      });
    }
  }

  moves.sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0));
  // Two specials sharing a frame name (Woody's two teleports) would share an
  // option name; the input tells them apart.
  const named = new Map();
  for (const mv of moves) named.set(mv.name, (named.get(mv.name) ?? 0) + 1);
  for (const mv of moves) if (mv.category === 'special' && named.get(mv.name) > 1) mv.name = `${mv.name ?? 'move'}_${mv.input}`;
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
  const order = [];
  let id = action;
  for (let step = 0; step < maxDepth && frames.has(id) && !seen.has(id); step++) {
    seen.add(id);
    const f = frames.get(id);
    let injury = 0;
    for (const it of damagingItr(f)) {
      injury = Math.max(injury, it.injury);
      damage = Math.max(damage, it.injury);
      fall = Math.max(fall, it.fall ?? 0);
      bdefend = Math.max(bdefend, it.bdefend ?? 0);
    }
    order.push({ id, injury, dvx: Math.abs(f.dvx ?? 0) });
    if (Math.abs(f.dvx ?? 0) > 0) moving = true;
    travelled += Math.abs(f.dvx ?? 0) * (f.wait ?? 0);
    const last = falloff.at(-1);
    if (last && last.injury === injury) last.to = travelled;
    else falloff.push({ to: travelled, injury });
    if (f.next === 1000) { range = travelled; break; }
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) { id = null; break; }
    id = f.next;
  }
  // A thing that flies until it hits spends its flight in the frames it loops
  // through, so a hit lands with theirs. Dennis's chasing ball opens on one
  // frame of 65 for 3 ticks, then loops at 40: of 219 clean hits, 213 did 39
  // or 40 and 4 did 65 (Dennis games from 2026-09-27).
  const loopAt = range === null && seen.has(id) ? order.findIndex((o) => o.id === id) : -1;
  if (loopAt >= 0) {
    const inLoop = Math.max(...order.slice(loopAt).map((o) => o.injury));
    if (inLoop > 0) damage = inLoop;
  }
  // Its own speed in flight, from the same frames; a spawn's push is added in
  // `spawnInfo`.
  const speed = Math.max(0, ...(loopAt >= 0 ? order.slice(loopAt) : order).map((o) => o.dvx)) || null;
  // Under 100 of travel the thing is placed, not thrown — Firen's and Julian's
  // explosions stand still, Firen's flame is a trail laid while he runs — and
  // where it lands depends on the caster, so no distance band describes it.
  const finite = range !== null && range >= 100 && damage > 0;
  return { damage, fall, bdefend, speed, travels: moving && damage > 0,
           range: finite ? Math.round(range) : null,
           falloff: finite ? falloff.filter((b) => b.injury > 0).map((b) => ({ to: Math.round(b.to), injury: b.injury })) : null };
}

/**
 * A spawn whose own frames carry no ordinary hit but still hurt: a chasing
 * ball (state 3005 with a `hit_Fa` chase mode, Firzen's disaster, Jan's and
 * Bat's chasers, Julian's balls) flies on from frames the start chain does not
 * reach, so the object's own best hit stands for it; Freeze's whirlwind and
 * icicles hit with the freezing kinds 15 and 16. Harmless smoke (Rudolf's
 * transform, state 3001) has neither and stays harmless.
 */
/**
 * The `hit_Fa` modes under which px.js (`Olrd`) turns a flying object toward
 * its target every frame, x by 0.7 and z by 0.4: Dennis's chase ball is 2,
 * Firzen's and Jan's chasers and Bat's are among the rest. Modes 3, 6, 8, 9
 * and 13 release such chasers (objects 220-228), each given an enemy to chase.
 */
const STEERS = new Set([2, 4, 7, 12, 14, 3, 6, 8, 9, 13]);

const steerCache = new Map();
/**
 * Whether a live object in frame `frameId` steers itself to its target, from
 * its plain frame table (`framesFor`). Frame-level, not object-level: John's
 * ball and his heal are one object entered at different frames.
 */
export function steers(id, frames, frameId) {
  const key = `${id}/${frameId}`;
  if (!steerCache.has(key)) {
    const map = new Map(Object.entries(frames ?? {}).map(([k, v]) => [Number(k), v]));
    steerCache.set(key, chases(map, frameId));
  }
  return steerCache.get(key);
}

/** Whether a spawn from this frame steers itself to its target. */
function chases(frames, action) {
  const seen = new Set();
  for (let id = action, step = 0; step < 20 && frames.has(id) && !seen.has(id); step++) {
    seen.add(id);
    const f = frames.get(id);
    if (STEERS.has(f.transitions?.Fa)) return true;
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) break;
    id = f.next;
  }
  return false;
}

function hiddenHit(frames, action, objectDamage) {
  const seen = new Set();
  for (let id = action, step = 0; step < 20 && frames.has(id) && !seen.has(id); step++) {
    seen.add(id);
    const f = frames.get(id);
    if (f.state === 3005 && f.transitions?.Fa) return objectDamage;
    const freeze = (f.itr ?? []).filter((it) => (it.kind === 15 || it.kind === 16) && it.injury > 0);
    if (freeze.length) return Math.max(...freeze.map((it) => it.injury));
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) break;
    id = f.next;
  }
  return 0;
}

/**
 * What a special does when it deals no damage the data can measure, read from
 * its own frames and what it spawns (px.js states: 1700 heals the caster, 400
 * and 401 teleport to an enemy and to an ally, 500/501 transform; itr kind 3
 * grabs, 8 heals whoever it touches, 10/11 lift and hold). A spawned character
 * is a clone and a spawned weapon lands in the caster's hands.
 */
function effectOf(chain, spawned) {
  const states = new Set(chain.map((f) => f.state));
  const kinds = new Set(chain.flatMap((f) => (f.itr ?? []).map((it) => it.kind)));
  if (states.has(1700)) return 'heal_self';
  if (states.has(400)) return 'teleport_to_enemy';
  if (states.has(401)) return 'teleport_to_ally';
  if (states.has(500) || states.has(501)) return 'transform';
  if (kinds.has(10) || kinds.has(11)) return 'lift';
  if (kinds.has(3)) return 'grab';
  if (spawned.some((o) => o?.type === 0)) return 'clone';
  if (spawned.some((o) => o?.type === 1)) return 'weapon';
  if (spawned.some((o) => o?.heals)) return 'heal_ally';
  return 'unknown';
}

/** A move's frames from its entry, following `next` until it ends or loops. */
function chainFrom(frames, entry, maxDepth = 40) {
  const out = [];
  const seen = new Set();
  for (let id = entry; out.length < maxDepth && frames.has(id) && !seen.has(id);) {
    seen.add(id);
    const f = frames.get(id);
    out.push(f);
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) break;
    id = f.next;
  }
  return out;
}

/**
 * What pressing Attack again while a shot plays adds. Some shots carry an
 * Attack transition into a frame with its own MP cost: Dennis's energy ball
 * goes on to a second ball and then a pair, Henry's five arrows and Rudolf's
 * stars loop back into themselves. The walk takes every such transition at
 * once (the executor presses Attack throughout, see `repeats` in actions.mjs)
 * and times each shot at wait + 1 ticks a frame. Null when nothing follows.
 *
 * `shots` lists every shot of the whole volley with its tick, damage and the
 * MP spent up to it; `loopMp`, `loopTicks` and `loopShots` describe the part
 * that repeats for as long as MP lasts, when it does.
 */
function volleyOf(frames, entry, spawnInfo, isProjectile, maxFrames = 80) {
  const shots = [];
  const linkAt = new Map();   // link entry frame -> index into `marks`
  const marks = [];           // { tick, mp, shots } at each link entry
  let tick = 0;
  let mp = 0;
  let links = 0;
  let loop = null;
  let id = entry;
  const seen = new Set();
  for (let n = 0; n < maxFrames && frames.has(id); n++) {
    const f = frames.get(id);
    if (typeof f.mp === 'number' && (id === entry || linkAt.has(id))) mp += Math.abs(f.mp) % 1000;
    for (const o of f.opoint ?? []) {
      const s = spawnInfo({ oid: o.oid, action: o.action ?? 0, count: (o.facing ?? 0) >= 10 ? Math.floor(o.facing / 10) : 1 });
      if (!isProjectile(s)) continue;
      for (let c = 0; c < (s.count ?? 1); c++) shots.push({ tick, damage: s.damage, mp });
    }
    const to = f.transitions?.a;
    if (to != null && frames.get(to)?.mp) {
      if (linkAt.has(to)) { loop = marks[linkAt.get(to)]; break; }
      linkAt.set(to, marks.length);
      marks.push({ tick: tick + (f.wait ?? 0) + 1, mp, shots: shots.length });
      links++;
      tick += (f.wait ?? 0) + 1;
      id = to;
      seen.clear();
      continue;
    }
    if (seen.has(id)) break;
    seen.add(id);
    tick += (f.wait ?? 0) + 1;
    if (typeof f.next !== 'number' || f.next <= 0 || f.next >= 999) break;
    id = f.next;
  }
  if (!links || shots.length < 2) return null;
  const out = { shots };
  if (loop) {
    out.loopShots = shots.length - loop.shots;
    out.loopMp = mp - loop.mp;
    // From a shot to the same shot one repeat later.
    out.loopTicks = shots.at(-1).tick - shots[shots.length - 1 - out.loopShots].tick;
  }
  return out;
}

/** A projectile's damage at a distance: its full hit if it has no range. */
export function damageAt(move, distance) {
  if (!move.falloff) return move.damage;
  return move.falloff.find((b) => distance <= b.to)?.injury ?? 0;
}

/**
 * A volley's damage at each distance. px.js sends copy `u` of `n` with a
 * depth speed of `10u/(n-1) - 5` a tick, taken off its forward speed, so the
 * outer copies drift off the target's line and miss once they are more than
 * `BOT.HIT_Z` of depth away. Henry's five arrows: all five land within 54,
 * three within 124, one beyond. Only a projectile with distance bands is
 * worked out; one that flies until it hits keeps its single-copy damage.
 */
function fanned(p) {
  const n = p.count ?? 1;
  if (n <= 1 || !p.falloff) return p;
  const speed = Math.abs(p.dvx ?? 0);
  const limits = Array.from({ length: n }, (_, u) => {
    const d = Math.abs((10 * u) / (n - 1) - 5);
    return d === 0 ? Infinity : (BOT.HIT_Z * (speed - d)) / d;
  });
  const cuts = [...new Set([...limits.filter(Number.isFinite), ...p.falloff.map((b) => b.to)])]
    .sort((a, b) => a - b).filter((c) => c <= p.range);
  const falloff = [];
  let from = 0;
  for (const to of cuts) {
    const single = p.falloff.find((b) => to <= b.to)?.injury ?? 0;
    const injury = single * limits.filter((l) => l > from).length;
    const last = falloff.at(-1);
    if (last && last.injury === injury) last.to = Math.round(to);
    else falloff.push({ to: Math.round(to), injury });
    from = to;
  }
  return { ...p, falloff, damage: Math.max(...falloff.map((b) => b.injury)) };
}

/** The strongest projectile's range and damage bands, or none if any flies on. */
function projectileRange(projectiles) {
  if (!projectiles.length || projectiles.some((p) => !p.falloff)) return { range: null, falloff: null };
  const best = projectiles.reduce((a, b) => ((b.damage ?? 0) > (a.damage ?? 0) ? b : a));
  return { range: best.range, falloff: best.falloff };
}

function flightOf(projectiles) {
  if (!projectiles.length) return {};
  const best = projectiles.reduce((a, b) => ((b.damage ?? 0) > (a.damage ?? 0) ? b : a));
  return best.homes ? { flightTicks: best.flightTicks ?? null } : { speed: best.speed ?? null };
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
      heals: [...frames.values()].some((f) => (f.itr ?? []).some((it) => it.kind === 8)),
      /** Not serialized: the same facts from one starting frame. */
      at: (action) => (frames.has(action) ? fromAction(frames, action) : null),
      /** Not serialized: a hit started from this frame that `at` cannot see. */
      hiddenAt: (action) => hiddenHit(frames, action, damage),
      /** Not serialized: whether a spawn from this frame chases its target. */
      chasesAt: (action) => chases(frames, action),
    });
  }
  return objects;
}
