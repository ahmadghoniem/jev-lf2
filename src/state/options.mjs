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

/** How a weapon's four swing types read as options. */
const SWING_STYLES = {
  normal: { input: 'a', label: 'swing', risk: 'low', note: 'from standing' },
  jump: { input: 'j+a', label: 'jump_swing', risk: 'medium', note: 'in the air, harder to punish on whiff but commits you' },
  run: { input: 'run+a', label: 'run_swing', risk: 'medium', note: 'while running in, closes distance with the hit' },
  dash: { input: 'dash+a', label: 'dash_swing', risk: 'high', note: 'the heaviest swing, and the slowest to recover from' },
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
 */
export function buildOptions({ profile, weapons, held, nearby = [], nearest = Infinity, mp = 0 }) {
  const options = {};

  const affordable = (m) => m.mp <= mp || m.allowedWhenShort;
  const basic = profile.basicAttack;

  // --- what the character can throw from where it stands
  for (const move of dedupe(profile.moves.filter((m) => m.kind === 'ranged' && affordable(m)), MAX_RANGED)) {
    const isBasic = basic && move.entry === basic.entry;
    options[isBasic ? 'shoot' : `special_${label(move)}`] = [
      'Attack from where you stand; it reaches any distance.',
      `Damage is ${move.damageTier}.`,
      move.mp === 0 ? 'Costs no MP.'
        : `Costs ${tierMp(move.mp)} MP${move.allowedWhenShort ? ', and still works when MP is short' : ''}.`,
      isBasic ? "This is this fighter's ordinary attack, so it is always available."
        : 'This is a special move.',
    ].join(' ');
  }

  // --- what it can do with its hands, and whether anything is in reach
  for (const move of dedupe(profile.moves.filter((m) => m.kind === 'melee' && !m.needsWeapon && affordable(m)), MAX_MELEE)) {
    const inReach = nearest <= move.reach + REACH_SLACK;
    options[label(move)] = [
      `${describeMelee(move)}.`,
      `Damage is ${move.damageTier}.`,
      inReach ? 'The enemy is already inside its reach.' : 'The enemy is out of its reach, so this means closing in first.',
      move.mp > 0 ? `Costs ${tierMp(move.mp)} MP.` : '',
    ].filter(Boolean).join(' ');
  }

  // --- what the weapon in hand is worth, per swing type
  if (held) {
    const table = weapons[held.id];
    if (table) {
      for (const [attack, row] of Object.entries(table.attacks)) {
        const style = SWING_STYLES[attack];
        if (!style) continue;
        options[`${style.label}_${plainName(table.name, held.name).replace(/ /g, "_")}`] = [
          `Hit with the ${plainName(table.name, held.name)} you are holding, ${style.note}.`,
          `Damage is ${tierDamage(row.injury)}.`,
          `Risk is ${style.risk}.`,
        ].join(' ');
      }
    }
    options.throw_weapon = `Throw the ${plainName(table?.name, held.name)} at the enemy. It travels, so distance does not matter, but you lose the weapon.`;
    options.drop_weapon = `Drop what you are holding and fight bare-handed.`;
  }

  // --- what is lying on the ground, priced the same way
  for (const item of nearby) {
    const table = weapons[item.id];
    const where = bucketRange(item.distance);
    if (item.type === 6) {
      options[`drink_${plainName(item.name).replace(/ /g, "_")}`] =
        `Go and drink the ${plainName(item.name)}, ${where} away. It restores health. You are defenceless while drinking.`;
      continue;
    }
    if (!table) continue;
    const best = Math.max(...Object.values(table.attacks).map((r) => r.injury));
    options[`pick_up_${plainName(table.name, item.name).replace(/ /g, "_")}`] = [
      `Go and pick up the ${plainName(table.name, item.name)}, ${where} away.`,
      `Its best hit is ${tierDamage(best)}, against ${profile.bestMelee ? tierDamage(profile.bestMelee.damage) : 'nothing'} bare-handed.`,
      held ? 'You would swap what you are holding for it.' : '',
      item.contested ? 'Someone else is closer to it than you are.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- the things that are always available
  options.close_distance = 'Move toward the enemy to get into range.';
  options.open_distance = 'Move away from the enemy to get out of its range.';
  options.defend = 'Hold block. Safe, but it gives up the initiative and a heavy hit breaks it.';
  options.wait = 'Hold position and do nothing this instant.';

  return options;
}

/** A hit that lands slightly outside the measured box still connects. */
const REACH_SLACK = 20;

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
const label = (move) => (move.name ?? `${move.input}_${move.entry}`).replace(/[^a-z0-9_]+/gi, '_');

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
};
const plainName = (...names) => {
  for (const n of names) if (n && FRIENDLY[n]) return FRIENDLY[n];
  for (const n of names) if (n) return n;
  return 'item';
};
