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

import { tierDamage, tierMp, bucketRange } from '../lf2data/profile.mjs';
import { REACH_SLACK } from '../lf2data/frames.mjs';

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
 * @param canDo      whether the executor can actually carry an option out
 */
export function buildOptions({ profile, weapons, held, nearby = [], nearest = Infinity, mp = 0,
                               hp = null, hpMax = null, behind = false, vulnerable = false,
                               enemyDoing = null, aligned = true, shootable = true,
                               hasTarget = false, mpLow = false, threatened = false,
                               helpless = false, weaponInbound = false, canDo = () => true }) {
  const options = {};

  const affordable = (m) => m.mp <= mp || m.allowedWhenShort;
  const basic = profile.basicAttack;

  // A hit needs the two fighters at the same depth, and a straight attack leaves
  // at our own height, so a target further back, nearer the camera, lying down or
  // airborne cannot be hit from here. Code does that arithmetic; the option is
  // simply not offered while it is true, rather than offered and wasted.
  const canShoot = hasTarget && shootable;
  const misaligned = hasTarget && !aligned;
  // While the enemy is down or airborne, nothing thrown from here connects, so
  // MP spent now is MP missing from the window that follows. Free moves stay on
  // the list; anything that costs MP waits.
  const bankMp = hasTarget && !shootable;

  // A swing already in the air is answered by a block or a step back, never by
  // an attack: the trade resolves on the enemy's frame data, not ours. The
  // warning goes on every committing option, because labelling only the safe
  // ones leaves the attacks reading as neutral and the policy picks the attack.
  const tradeWarning = threatened
    ? 'An enemy swing is already coming, so this would land second and you would take the hit.'
    : '';
  // A thrown weapon is a second, quieter threat: it is already travelling, so an
  // answer has to be a block or a step out of its line, never a walk toward it.
  const thrownWarning = weaponInbound
    ? 'A thrown weapon is already in the air coming at you, and it hurts on contact.'
    : '';
  /** Anything that commits is the wrong answer to either kind of incoming danger. */
  const commitWarning = [tradeWarning, thrownWarning].filter(Boolean).join(' ');

  // A free window is the one branch that opens because of the enemy rather than
  // for us: a fighter locked in a drink or a recovery cannot move or block, so
  // reaching it and hitting it is unanswerable for as long as it lasts. Offered
  // as one option so the choice is "punish or not", not which key to press.
  // Only offered into a window we can walk into: a locked enemy cannot answer,
  // but a recovering one may have released a weapon a moment ago, and rushing in
  // to that is the trade the loss runs are full of. Committing on top of an
  // incoming swing or a weapon in the air is never a punish.
  const window = vulnerable && !threatened && !weaponInbound ? (enemyDoing ?? 'stuck') : null;
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
  const ranged = profile.moves.filter((m) => m.kind === 'ranged' && affordable(m)
    && canShoot && canDo(rangedName(m)));
  for (const move of dedupe(ranged, MAX_RANGED)) {
    const isBasic = basic && move.entry === basic.entry;
    options[rangedName(move)] = [
      'Attack from where you stand; it reaches any distance.',
      `Damage is ${move.damageTier}.`,
      move.mp === 0 ? 'Costs no MP.'
        : `Costs ${tierMp(move.mp)} MP${move.allowedWhenShort ? ', and still works when MP is short' : ''}.`,
      isBasic ? "This is this fighter's ordinary attack, so it is always available."
        : 'This is a signature special move, and the only way to hurt an enemy without walking into its range.',
      window ? 'The enemy is helpless right now, so this cannot be answered or blocked.' : '',
      behind ? 'You will turn to face the enemy first.' : '',
      commitWarning,
      move.mp > 0 ? 'MP comes back slowly and this is spent even on a miss.' : '',
      mpLow && move.mp > 0 ? 'Your MP is nearly gone — save it for a moment you cannot otherwise answer.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- what it can do with its hands, and whether anything is in reach
  const melee = profile.moves.filter((m) => m.kind === 'melee' && !m.needsWeapon
    && affordable(m) && (!bankMp || m.mp === 0) && canDo(label(m)));
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
      inReach ? 'The enemy is already inside its reach.'
        : misaligned ? 'You are not level with the enemy, so this needs you to line up first.'
        : 'The enemy is out of its reach, so this means closing in first.',
      window ? 'The enemy is helpless right now, so this cannot be answered or blocked.' : '',
      behind ? 'The enemy is behind you; you will turn first, which costs a moment.' : '',
      commitWarning,
      move.mp > 0 ? `Costs ${tierMp(move.mp)} MP.` : '',
      bankMp ? 'The enemy is down or in the air, so MP-costing moves are held back until it is back on your line.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- what the weapon in hand is worth, per swing type. Only ever listed while
  // the weapon is confirmed to be in hand, so the swing is real.
  if (held) {
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
          commitWarning,
        ].filter(Boolean).join(' ');
      }
    }
    options.throw_weapon = `Throw the ${weaponName} at the enemy. It travels, so distance does not matter, but you lose the weapon.`
      + (commitWarning ? ` ${commitWarning}` : '');
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
  options.close_distance = (behind
    ? 'Turn around and move toward the enemy to get into range.'
    : 'Move toward the enemy to get into range.')
    + (tradeWarning ? ` ${tradeWarning}` : '');
  options.open_distance = 'Move away from the enemy to get out of its range.'
    + (threatened ? ' A swing is already coming, so stepping back now is what avoids it.' : '')
    // Outrunning a thrown weapon does not work: it is travelling at you, so
    // retreating keeps you on its line and spends the ticks a block needed.
    + (weaponInbound ? ' This will not outrun a weapon that is already flying at you — block it instead.' : '');
  options.defend = 'Hold block. Safe, but it gives up the initiative and a heavy hit breaks it.'
    + (threatened ? ' An enemy is swinging at you right now, so this is the direct answer to it.' : '')
    + (weaponInbound ? ' It also stops a thrown weapon, so this is the direct answer to that.' : '');
  options.wait = 'Hold position and do nothing this instant.'
    + (threatened ? ' Standing still will not avoid a swing that is already coming.' : '')
    + (weaponInbound ? ' Standing still will not avoid a weapon already flying at you.' : '');

  return options;
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
  rudolf_weapon: "Rudolf's staff", henry_arrow1: 'arrow',
};
/** Option names are read back as identifiers, so keep them to letters, digits, `_`. */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export const plainName = (...names) => {
  for (const n of names) if (n && FRIENDLY[n]) return FRIENDLY[n];
  for (const n of names) if (n) return n;
  return 'item';
};
