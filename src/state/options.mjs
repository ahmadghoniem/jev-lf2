/**
 * Turns the live arena into the labelled options Jev chooses between.
 *
 * The rule is not "code decides, Jev obeys". Code does the arithmetic — which
 * attacks can reach, what each one costs, what a held weapon hits for — and
 * then hands Jev every option that is actually available, each described in
 * words, including how hard it hits and what it risks. Choosing among them is
 * the judgement, and that is Jev's.
 *
 * So Jev is the one that decides a crossbow shot beats closing to punch, or
 * that the baseball bat's dash swing is worth the commitment. It never has to
 * subtract two numbers to get there, because the numbers arrive as tiers.
 */

import { tierDamage, bucketRange, damageAt } from '../lf2data/profile.mjs';
import { mpRegenPerSecond } from './fields.mjs';
import { REACH_SLACK } from '../lf2data/frames.mjs';
import { STANDOFF_X, RUN_IN_MIN_X, RUN_OUT_MAX_X } from './bot.mjs';

/** How a weapon's four swing types read as options. */
const SWING_STYLES = {
  normal: { input: 'a', label: 'swing', risk: 'low',
            note: 'a plain swing from standing: the quickest to come out and the quickest to recover' },
  jump: { input: 'j+a', label: 'jump_swing', risk: 'medium',
          note: 'jump first, then swing on the way down; it reaches over a low enemy but leaves you in the air' },
  run: { input: 'run+a', label: 'run_swing', risk: 'medium',
         note: 'run in and swing, so the swing itself carries you into range' },
  dash: { input: 'dash+a', label: 'dash_swing', risk: 'high',
          note: 'the heaviest and slowest swing, a dash that commits you to the follow-through' },
};

/**
 * Every action worth offering this tick.
 *
 * @param me         the controlled fighter, from the entity reader
 * @param profile    its entry from build/_profiles.json
 * @param weapons    build/_weapons.json
 * @param held       the weapon entity in hand, or null
 * @param nearby     weapon and drink entities on the ground, with distances
 * @param nearest    distance to the closest threat, in game units
 * @param targetDown the nearest enemy is on the floor or in the air
 * @param canDo      whether the executor can actually carry an option out
 */
/** Room the roll needs behind the fighter to end out of reach. */
const ROLL_ROOM = 180;

export function buildOptions({ profile, weapons, held, nearby = [], nearest = Infinity, mp = 0,
                               hp = null, hpMax = null, behind = false, vulnerable = false,
                               enemyDoing = null, aligned = true, targetDown = false,
                               hasTarget = false, threatened = false, targetOnScreen = true,
                               helpless = false, weaponInbound = false, guardWorn = false,
                               roomBehind = Infinity,
                               canDo = () => true }) {
  const options = {};

  const affordable = (m) => m.mp <= mp || m.allowedWhenShort;
  const basic = profile.basicAttack;
  const cost = (m) => mpCost(m, { mp, hp, profile });

  // Where a fighter that can fire wants to stand, and so where "close the
  // distance" stops meaning "walk into it". A fighter with nothing to fire has
  // to close all the way, and its stand-off is zero.
  const standoff = profile.hasRanged ? STANDOFF_X : 0;

  const misaligned = hasTarget && !aligned;
  // A target on the floor or in the air cannot be hit by anything fired from
  // where we stand. This used to gate only the moves that cost MP, which left
  // the free melee attacks on the list — and the run data shows what that bought:
  // 50-odd ticks of dash_attack chosen at a knocked-down enemy 200-430 away,
  // dashing at a corpse. Now no attack stays on the list while the target is
  // down; the useful things then are to wait or to drink.

  // A free window is the one branch that opens because of the enemy rather than
  // for us: a fighter locked in a drink or a recovery cannot move or block, so
  // reaching it and hitting it is unanswerable for as long as it lasts. Offered
  // as one option so the choice is "punish or not", not which key to press.
  // Only offered into a window we can walk into: a locked enemy cannot answer,
  // but a recovering one may have released a weapon a moment ago, and rushing in
  // to that is the trade the loss runs are full of. Committing on top of an
  // incoming swing or a weapon in the air is never a punish.
  const window = vulnerable ? (enemyDoing ?? 'stuck') : null;
  if (window) {
    options.rush_attack = helpless
      ? `The enemy is ${window} and cannot move or block for the moment. Close in and hit it before it recovers.`
      : `The enemy is ${window} at the end of an attack, so it cannot swing again yet — but it may already have a weapon in the air. Close in and hit it before it recovers.`;
  }

  // Two branches below are opened by the situation, not merely filled by it. A
  // potion is only an option when there is health to win back, and a weapon on
  // the ground is only an option when it beats what the hands would otherwise
  // swing. Jev is documented as distracted by large irrelevant state, so a
  // branch that is closed reads better than one that is merely pointless.
  const healthFraction = hpMax ? hp / hpMax : 1;
  const heldTable = held ? weapons[held.id] : null;
  const carriedSwing = heldTable
    ? Math.max(...Object.values(heldTable.attacks).map((r) => r.injury))
    : (profile.bestMelee?.damage ?? 0);

  // --- what the character can throw from where it stands
  const rangedName = (m) => (basic && m.entry === basic.entry ? 'shoot' : `special_${label(m)}`);
  // A short-lived projectile is offered only while the enemy is inside its
  // full-damage band, because that is where the executor fires it; further
  // out it walks in first, and the observer saw Henry walk toward Rudolf's
  // stars with arrows he could have fired instead.
  // Nothing is fired at an enemy off the screen: the observer saw every such
  // shot as wasted, and the log agrees (arrows fired from 700 on landed 1 in 7).
  const ranged = profile.moves.filter((m) => m.kind === 'ranged' && affordable(m)
    && !targetDown && (!hasTarget || (targetOnScreen
      && damageAt(m, nearest) >= (m.falloff ? m.falloff[0].injury : 1)))
    && canDo(rangedName(m)));
  for (const move of dedupe(ranged, MAX_RANGED)) {
    const isBasic = basic && move.entry === basic.entry;
    options[rangedName(move)] = [
      reachText(move, hasTarget ? nearest : null),
      `Damage is ${move.damageTier}${move.falloff ? ' up close' : ''}.`,
      effects(move),
      cost(move),
      isBasic ? "This is this fighter's ordinary attack, so it is always available."
        : 'This is a signature special move, and the only way to hurt an enemy without walking into its range.',
      window ? 'The enemy is helpless right now, so this cannot be answered or blocked.' : '',
      behind ? 'You will turn to face the enemy first.' : '',
      move.mp > 0 ? 'The MP is spent even on a miss.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- what it can do with its hands, and whether anything is in reach
  const melee = profile.moves.filter((m) => m.kind === 'melee' && !m.needsWeapon
    && affordable(m) && !targetDown && canDo(label(m)));
  // The ordinary attack always belongs on the list. It costs nothing, it is the
  // archetype in one option, and the cap would otherwise spend all four slots on
  // heavier variants and drop the one move that is always available.
  // Compared by entry frame, not by identity: the profile comes back from JSON,
  // so `basicAttack` and its twin in `moves` are separate objects.
  const shortlist = dedupe(melee, MAX_MELEE);
  const basicMove = basic ? melee.find((m) => m.entry === basic.entry) : null;
  if (basicMove && !shortlist.some((m) => m.entry === basicMove.entry)) shortlist.push(basicMove);
  for (const move of shortlist) {
    const inReach = aligned && nearest <= move.reach + REACH_SLACK;
    options[label(move)] = [
      `${describeMelee(move)}.`,
      `Damage is ${move.damageTier}.`,
      effects(move),
      inReach ? 'The enemy is already inside its reach.'
        : misaligned ? 'You are not level with the enemy, so this needs you to line up first.'
        : 'The enemy is out of its reach, so this means closing in first.',
      window ? 'The enemy is helpless right now, so this cannot be answered or blocked.' : '',
      behind ? 'The enemy is behind you; you will turn first, which costs a moment.' : '',
      cost(move),
    ].filter(Boolean).join(' ');
  }

  // --- what the weapon in hand is worth, per swing type. Only ever listed while
  // the weapon is confirmed to be in hand, so the swing is real.
  if (held && !targetDown) {
    const table = weapons[held.id];
    const weaponName = plainName(table?.name, held.name);
    if (table) {
      for (const [attack, row] of Object.entries(table.attacks)) {
        const style = SWING_STYLES[attack];
        if (!style) continue;
        options[`${style.label}_${slug(weaponName)}`] = [
          `${weaponName} — ${style.note}.`,
          `Damage is ${tierDamage(row.injury)}.`,
          `Risk is ${style.risk}.`,
          'This is available because the weapon is in your hands right now.',
        ].filter(Boolean).join(' ');
      }
    }
    options.throw_weapon = `Throw the ${weaponName} at the enemy. It travels, so distance does not matter, but you lose the weapon.`;
    options.drop_weapon = `Drop what you are holding and fight bare-handed.`;
  }

  // --- what is lying on the ground, priced the same way
  for (const item of nearby) {
    const table = weapons[item.id];
    const where = bucketRange(item.distance);
    if (item.type === 6) {
      if (healthFraction >= DRINK_BELOW) continue;
      options[`drink_${slug(plainName(item.name))}`] = [
        `Walk over and drink the ${plainName(item.name)}, ${where} away.`,
        'It restores health, but you are defenceless the whole way there and while drinking.',
        item.aligned === false ? 'It is not level with you, so you must step to its depth to pick it up.' : '',
      ].filter(Boolean).join(' ');
      continue;
    }
    if (!table) continue;
    const best = Math.max(...Object.values(table.attacks).map((r) => r.injury));
    if (best <= carriedSwing) continue;
    const farther = item.distance > nearest;
    options[`pick_up_${slug(plainName(table.name, item.name))}`] = [
      `Walk over and pick up the ${plainName(table.name, item.name)}, ${where} away.`,
      'You cannot attack or block while walking to it, and the enemy is free to hit you the whole way.',
      `Its best swing is ${tierDamage(best)}, against ${tierDamage(carriedSwing)} from ${held ? 'what you are holding' : 'your bare hands'}.`,
      item.aligned === false ? 'It is not level with you, so you must step to its depth to pick it up.' : '',
      farther ? 'The enemy is closer to you than the weapon is, so it will reach you before you reach it.' : '',
      held ? 'You would drop what you are already holding to take it.' : '',
      item.contested ? 'Someone else is closer to it than you are.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- the things that are always available
  // Movement is a gear as well as a direction. The game reads a run only from a
  // double-tap, so running is a separate choice: it covers ground about twice as
  // fast, but commits to the direction, where walking can be revised every tick.
  // Offered once the distance is long enough that walking would be slow, and
  // out to a run when there is ground to cover to break off.
  if (hasTarget && nearest > RUN_IN_MIN_X) {
    options.run_in = 'Run at the enemy — double-tap toward it. It closes ground about twice as fast as walking, but the direction is committed for the burst.';
  }
  if (hasTarget && nearest <= RUN_OUT_MAX_X) {
    options.run_out = 'Run away from the enemy — double-tap away from it. It breaks off quickly to reset the distance, where walking away is slow.';
  }

  options.close_distance = hasTarget && !targetOnScreen
    ? 'The enemy is off the screen, out of reach of anything you can fire. Walk toward it until it is back on screen, then shoot from there.'
    : behind
    ? (standoff
      ? 'Turn around, close on the enemy and stop at your firing range — near enough to shoot, too far to be punched.'
      : 'Turn around and move toward the enemy to get into range.')
    : (standoff
      ? 'Close on the enemy, but stop at your firing range. Once the shot reaches, hold and fire rather than walking in.'
      : 'Move toward the enemy to get into range.');
  options.open_distance = 'Move away from the enemy, walking, to get out of its reach. Nothing is committed, so it can be changed at any moment.';
  // Blocking is only ever worth it while something is actually on its way: a
  // guard held against an idle enemy does nothing, wears down, and breaks on
  // the first real volley — the run data has 73 defend ticks with the enemy
  // more than 120 away. So the option closes unless a swing is live, a weapon
  // is inbound, or the enemy is close enough to swing at any moment.
  // The two defences are described against each other, because each is right
  // where the other is wrong: the block is instant but finite and leaves you
  // where you stand, the roll takes a moment to start but nothing gets through
  // it and it ends out of reach.
  if (threatened || weaponInbound || (hasTarget && nearest <= 100)) {
    options.defend = 'Block what is coming. It goes up at once, so it is the answer to something about to land, and it stops thrown stars, arrows and most swings from the front; it drops by itself once nothing is coming. But you stay where you are, heavy hits that knock you down go through it, and it breaks after several blocked hits in a row.'
      + (guardWorn ? ' Your guard is worn from the hits just taken: the next blocked hit breaks it, and the one after that lands in full while you stagger.' : '');
  }
  // A roll has no hurt box for its whole length, so it is the one answer that
  // takes no damage at all. It is reached from a run, which is why it cannot
  // answer a weapon that is about to land.
  // The roll carries about 200, so against the edge of the stage it ends in
  // the corner rather than out of reach (seen by the observer on both sides).
  if (hasTarget && roomBehind >= ROLL_ROOM && (threatened || weaponInbound || nearest <= 220)) {
    options.roll_away = [
      'Roll away from the enemy: a short run, then a tumble along the ground. Nothing can hit you during the tumble and nothing breaks it, and you end about 200 further away, out of its reach.',
      'It takes about a third of a second to start, so it is for an enemy that is close or pressing you, not for a weapon about to land.',
      nearest <= 100 ? 'The enemy is inside punching range, where blocking only waits for the next hit; this gets you out.' : '',
      'You cannot attack or block until it finishes.',
    ].filter(Boolean).join(' ');
  }
  options.wait = 'Hold position and do nothing this instant.';

  return options;
}

/**
 * How far a projectile carries, and what it would do from here. A move with no
 * range keeps its hit at any distance; a short-lived one is described band by
 * band, which is what separates Henry's blastpush (80, but only up close) from
 * his super arrow (50 at any distance) once they are side by side.
 */
function reachText(move, distance) {
  if (!move.falloff) return 'Attack from where you stand. It flies until it hits and does the same damage at any distance.';
  const [first, ...rest] = move.falloff;
  const fades = rest.map((b) => `${b.injury} to about ${b.to}`).join(', ');
  const now = distance === null ? null : damageAt(move, distance);
  return [
    `Attack from where you stand, but it is short-lived: its full ${first.injury} lands only within about ${first.to} of you,`,
    fades ? `then it weakens (${fades}) and is gone beyond that.` : 'and it is gone beyond that.',
    now === null ? ''
      : now === first.injury ? `The enemy is close enough to take the full ${now}.`
      : `At the enemy's distance now it would hit for only ${now}, which is ${tierDamage(now)}.`,
  ].filter(Boolean).join(' ');
}

/**
 * What a hit does besides its damage. Two moves with the same damage tier read
 * identically without this, and Henry's 200 MP super arrow looked like a plain
 * shot with a price tag, so Jev never chose it.
 */
const effects = (move) => [
  move.knocksDown ? 'Knocks the enemy down in one hit, which stops its attack and buys time.'
    : 'Only staggers a fresh enemy; it goes down after a second quick hit.',
  move.breaksGuard ? 'Goes through a block.' : '',
].filter(Boolean).join(' ');

/**
 * What a move costs, worked out against the MP in hand, so Jev never has to do
 * the arithmetic or compare tiers: the exact price, how many times it can be
 * paid now, what is left after one, whether that still buys a special, and how
 * long the bar takes to pay for it again. The same sentence for every fighter,
 * because the costs are read from the data and the refill rate from px.js.
 */
export function mpCost(move, { mp, hp, profile }) {
  if (!move.mp) return move.hpCost ? `Costs no MP but ${move.hpCost} HP.` : 'Costs no MP.';
  const hpPart = move.hpCost ? ` and ${move.hpCost} HP` : '';
  if (move.allowedWhenShort && move.mp <= 20) {
    return `Costs only ${move.mp} MP${hpPart}, and still works when MP runs out.`;
  }
  const times = Math.floor(mp / move.mp);
  const left = mp - move.mp;
  const specials = profile.moves.filter((m) => m.mp > 20 && !m.allowedWhenShort);
  const cheapest = specials.length ? Math.min(...specials.map((m) => m.mp)) : Infinity;
  const priciest = specials.length ? Math.max(...specials.map((m) => m.mp)) : 0;
  const regen = mpRegenPerSecond(hp ?? 500);
  const again = left >= move.mp ? 'enough to use it again'
    : left >= cheapest ? `enough for a cheaper special but not this one again for about ${Math.ceil((move.mp - left) / regen)} s`
    : `too little for any special for about ${Math.ceil((Math.min(cheapest, move.mp) - Math.max(0, left)) / regen)} s`;
  return [
    `Costs ${move.mp} of your ${mp} MP${hpPart}`,
    times > 1 ? `(you can afford it ${times} times)` : '',
    `, leaving ${Math.max(0, left)}: ${again}.`,
    specials.length > 1 && move.mp === priciest ? 'It is your most expensive move.' : '',
  ].filter(Boolean).join(' ').replace(' ,', ',');
}

/** Below this fraction of health a potion is worth the walk; above it, the branch closes. */
const DRINK_BELOW = 0.75;

/**
 * Jev is documented as distracted by large irrelevant state, and most of a
 * character's move list is near-duplicates — four frames of the same ball, the
 * same punch from two stances. Options are collapsed to one per distinct
 * (damage tier, MP tier) pair, cheapest and fastest first, then capped.
 */
const MAX_RANGED = 3;
const MAX_MELEE = 4;

function dedupe(moves, limit) {
  const byShape = new Map();
  for (const m of [...moves].sort((a, b) => a.mp - b.mp || a.startupTicks - b.startupTicks)) {
    const key = `${m.damageTier}/${m.mpTier}`;
    if (!byShape.has(key)) byShape.set(key, m);
  }
  return [...byShape.values()]
    .sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0))
    .slice(0, limit);
}

/** A readable option name: the frame's own name, else the input that reaches it. */
export const label = (move) => (move.name ?? `${move.input}_${move.entry}`).replace(/[^a-z0-9_]+/gi, '_');

function describeMelee(move) {
  if (move.name === 'dash_attack') return 'Dash in and attack, which commits you to the movement';
  if (move.name === 'run_attack') return 'Run in and attack, closing distance with the hit';
  if (move.name === 'jump_attack') return 'Jump and attack on the way down';
  if (move.name === 'super_punch') return 'Throw the heavy punch';
  if (move.name === 'punch') return 'Punch from where you stand';
  return `Use ${move.name ?? 'the move'}`;
}

/** `weapon5` means nothing to a reader; the registry name does. */
const FRIENDLY = {
  weapon0: 'stick', weapon1: 'stone', weapon2: 'hoe', weapon3: 'boulder', weapon4: 'knife',
  weapon5: 'baseball bat', weapon6: 'milk', weapon7: 'ice sword', weapon8: 'beer',
  weapon9: 'blade', weapon10: 'armour', weapon11: 'armour',
  rudolf_weapon: "Rudolf's throwing star", henry_arrow1: 'arrow',
};
/** Option names are read back as identifiers, so keep them to letters, digits, `_`. */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export const plainName = (...names) => {
  for (const n of names) if (n && FRIENDLY[n]) return FRIENDLY[n];
  for (const n of names) if (n) return n;
  return 'item';
};
