/**
 * Turns the live arena into the labelled options Jev chooses between.
 *
 * The rule is not "code decides, Jev obeys". Code does the arithmetic — which
 * attacks can reach and what each one costs — and
 * then hands Jev every option that is actually available, each described in
 * words, including how hard it hits and what it risks. Choosing among them is
 * the judgement, and that is Jev's.
 *
 * So Jev is the one that decides a shot beats closing to punch. It never has to
 * subtract two numbers to get there, because the numbers arrive as tiers.
 */

import { tierDamage, bucketRange, damageAt } from '../lf2data/profile.mjs';
import { mpRegenPerSecond } from './fields.mjs';
import { REACH_SLACK, dashBand } from '../lf2data/frames.mjs';
import { standoffOf, RUN_IN_MIN_X, RUN_OUT_MAX_X, DASH_MIN_GAP, PRESS_EVERY } from './bot.mjs';
import { framesFor } from '../lf2data/tables.mjs';

/**
 * Whether a move fires an energy ball: an object whose first frame is state
 * 3000. The CPU blocks every one of these that comes within 200 of it while it
 * is free to act (px.js TI2f); arrows, stars and blasts are not in it.
 */
export const firesBall = (move) => (move.spawns ?? []).some((id) => {
  const f = framesFor(id);
  const first = f && Object.values(f)[0];
  return first?.state === 3000;
});

/** An enemy in one of these can turn and block. */
export const FREE_TO_BLOCK = new Set(['neutral', 'walking', 'running', 'blocking']);

/** How a weapon's four swing types read as options. */
/** Room the roll needs behind the fighter to end out of reach. */
const ROLL_ROOM = 180;
/**
 * Room a run away needs, and a walk away. Against the edge of the stage both
 * press into it: in one run Henry spent most of his last 250 hp at the right
 * edge answering run_out and open_distance, with his back to Rudolf.
 */
const RUN_OUT_ROOM = 150;
const WALK_OUT_ROOM = 40;

/**
 * Every action worth offering this tick.
 *
 * @param profile    its entry from build/_profiles.json
 * @param nearby     things lying on the ground, with distances; none is
 *                   offered now (weapons: offered thousands of times across
 *                   52 runs and never chosen; drinks: see below)
 * @param nearest    distance to the closest threat, in game units
 * @param targetDown nothing started now can hit the nearest enemy: it is on
 *                   the floor, or in a jump close by (`unhittable` in arena.mjs)
 * @param roomBehind ground between the fighter and the stage edge behind it
 * @param canDo      whether the executor can actually carry an option out
 */
export function buildOptions({ profile, nearby = [], nearest = Infinity, mp = 0,
                               hp = null, hpMax = null, behind = false, vulnerable = false,
                               enemyDoing = null, aligned = true, targetDown = false,
                               hasTarget = false, threatened = false, targetOnScreen = true,
                               helpless = false, weaponInbound = false, guardWorn = false,
                               roomBehind = Infinity, allies = 0,
                               canDo = () => true }) {
  const options = {};

  const affordable = (m) => m.mp <= mp || m.allowedWhenShort;
  const basic = profile.basicAttack;
  const cost = (m) => mpCost(m, { mp, hp, profile });

  // Where a fighter that can fire wants to stand, and so where "close the
  // distance" stops meaning "walk into it". A fighter with nothing to fire has
  // to close all the way, and its stand-off is zero.
  const standoff = standoffOf(profile);

  const misaligned = hasTarget && !aligned;
  // No attack stays on the list while the target cannot be hit: gating only
  // the moves that cost MP left 50-odd ticks of dash_attack chosen at a
  // knocked-down enemy 200-430 away. A jump further off than a shot takes to
  // arrive does not count, since the enemy has landed by then.

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
    options.rush_attack = enemyDoing === 'drinking'
      ? 'The enemy is drinking to heal: it cannot move, block or hit back until it finishes, and every moment it keeps drinking comes back to it as health. Run in and hit it; the first hit also stops the drink.'
      : helpless
      ? `The enemy is ${window} and cannot move or block for the moment. Close in and hit it before it recovers.`
      : `The enemy is ${window} at the end of an attack, so it cannot swing again yet — but it may already have a weapon in the air. Close in and hit it before it recovers.`;
  }

  // --- what the character can throw from where it stands
  const rangedName = (m) => (basic && m.entry === basic.entry ? 'shoot' : `special_${label(m)}`);
  // A short-lived projectile is offered only while the enemy is inside its
  // full-damage band, because that is where the executor fires it; further
  // out it walks in first, and the observer saw Henry walk toward Rudolf's
  // stars with arrows he could have fired instead.
  // Nothing is fired at an enemy off the screen: the observer saw every such
  // shot as wasted, and the log agrees (arrows fired from 700 on landed 1 in 7).
  // A short-lived one stays on the list for as long as it still does damage
  // at the enemy's distance, which its description states: kept to its
  // full-damage band, Henry's five arrows (full within 54) were offered in 10
  // of 131 decisions of one game.
  const reachable = profile.moves.filter((m) => m.kind === 'ranged' && affordable(m)
    && !targetDown && (!hasTarget || (targetOnScreen && damageAt(m, nearest) > 0))
    && canDo(rangedName(m)));
  // On the enemy's line a straight shot that chains beats a single steering
  // one: it goes off as soon, flies faster (Dennis's energy ball 15 a tick,
  // his chasing ball about 8) and keeps coming while Attack is pressed. The
  // steering ball's one advantage, needing no lining up, is worth nothing
  // there. Described side by side, level with Freeze, Jev still picked
  // Dennis's chasing ball 29 times to his energy ball's 2 (4 games,
  // 2026-09-26). Off the line both are offered.
  const chains = reachable.some((m) => !m.homes && m.volley);
  const ranged = hasTarget && aligned && chains
    ? reachable.filter((m) => !m.homes || m.volley) : reachable;
  // Specials are never collapsed: they are asked about as a group anyway
  // (src/state/nest.mjs), and every one a fighter has should be on offer.
  const rangedList = [...dedupe(ranged.filter((m) => m.category !== 'special'), MAX_RANGED),
    ...ranged.filter((m) => m.category === 'special')];
  for (const move of rangedList) {
    const isBasic = basic && move.entry === basic.entry;
    options[rangedName(move)] = [
      reachText(move, hasTarget ? nearest : null),
      fireText(move),
      volleyText(move),
      `Damage is ${move.damageTier}${move.falloff ? ' up close' : ''}${move.volley ? ' per shot' : ''}.`,
      effects(move),
      cost(move),
      isBasic ? "This is this fighter's ordinary attack, so it is always available."
        : 'This is a signature special move, and the only way to hurt an enemy without walking into its range.',
      window ? 'The enemy is helpless right now, so this cannot be answered or blocked.' : '',
      hasTarget && firesBall(move) && FREE_TO_BLOCK.has(enemyDoing)
        ? 'The enemy is free to act, and a computer enemy blocks every energy ball that comes near it while it is free; this lands when it is busy attacking, hurt, in the air or getting up.'
        : '',
      behind ? 'You will turn to face the enemy first.' : '',
      move.mp > 0 ? 'The MP is spent even on a miss.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- what it can do with its hands, and whether anything is in reach
  // A dash attack at an enemy nearer than the dash carries goes past it.
  // A melee special is named like the ranged ones, so it is grouped with them
  // and fired by their executor. Named by its frame alone it had no executor
  // and was never offered: Davis's many_punch and singlong, 2026-09-24.
  const meleeName = (m) => (m.category === 'special' ? `special_${label(m)}` : label(m));
  const melee = profile.moves.filter((m) => m.kind === 'melee' && !m.needsWeapon
    && affordable(m) && !targetDown && canDo(meleeName(m))
    && !(m.name === 'dash_attack' && hasTarget && nearest < (dashBand(profile)?.near ?? DASH_MIN_GAP))
    // The jump attack is not offered. Its Attack is pressed 7 ticks into the
    // jump and the hitting frames play out near the top of it: across the
    // recorded runs 3 of 63 presses in the air landed (5%), 0 of 19 at a
    // staggered enemy, and the fighter came down open (2026-09-28T21-03-09,
    // ticks 837-862: hit on landing, 178 to 124).
    && m.name !== 'jump_attack');
  // The ordinary attack always belongs on the list. It costs nothing, it is the
  // archetype in one option, and the cap would otherwise spend all four slots on
  // heavier variants and drop the one move that is always available.
  // Compared by entry frame, not by identity: the profile comes back from JSON,
  // so `basicAttack` and its twin in `moves` are separate objects.
  const shortlist = [...dedupe(melee.filter((m) => m.category !== 'special'), MAX_MELEE),
    ...melee.filter((m) => m.category === 'special')];
  const basicMove = basic ? melee.find((m) => m.entry === basic.entry) : null;
  if (basicMove && !shortlist.some((m) => m.entry === basicMove.entry)) shortlist.push(basicMove);
  for (const move of shortlist) {
    const inReach = aligned && nearest <= move.reach + REACH_SLACK;
    options[meleeName(move)] = [
      `${describeMelee(move)}.`,
      move.category === 'special' ? 'This is a signature special move, fired up close.' : '',
      fireText(move),
      `Damage is ${move.damageTier}.`,
      effects(move),
      inReach ? 'The enemy is already inside its reach.'
        : misaligned ? 'You are not level with the enemy, so this needs you to line up first.'
        : 'The enemy is out of its reach, so this means closing in first.',
      window ? 'The enemy is helpless right now, so this cannot be answered or blocked.' : '',
      behind ? 'The enemy is behind you; you will turn first, which costs a moment.' : '',
      cost(move),
      // An archer's attack button fires an arrow that costs MP even point
      // blank, so without saying so the free melee moves read as the weaker
      // choice: offered about 110 times in one run, chosen never, while the
      // observer watched Henry spend 150 MP on blastpush at 70 away.
      !move.mp && basic?.kind === 'ranged'
        ? `Your ordinary attack and your specials spend MP even point blank, so this is the hit to use up close${mp < 150 ? ', especially now that MP is short' : ''}, and it saves MP for the specials.`
        : '',
    ].filter(Boolean).join(' ');
  }

  // --- specials that do something other than hit: heal, teleport, clone...
  // Each is offered while it has something to act on; one that needs an ally
  // waits for one.
  for (const move of profile.moves.filter((m) => m.kind === 'utility')) {
    if (!affordable(move)) continue;
    const needs = {
      heal_self: hp < hpMax,
      heal_ally: allies > 0,
      teleport_to_ally: allies > 0,
      teleport_to_enemy: hasTarget && !targetDown,
      lift: hasTarget && !targetDown,
      grab: hasTarget && !targetDown,
    }[move.effect] ?? true;
    const name = `special_${label(move)}`;
    if (!needs || !canDo(name)) continue;
    const inReach = aligned && nearest <= (move.reach ?? 0) + REACH_SLACK;
    options[name] = [
      UTILITY_TEXT[move.effect]?.(move) ?? UTILITY_TEXT.unknown(move),
      move.effect === 'grab' ? (inReach ? 'The enemy is already inside its reach.' : 'The enemy is out of its reach, so this means closing in first.') : '',
      'This is a signature special move.',
      cost(move),
      move.mp > 0 ? 'The MP is spent even if nothing comes of it.' : '',
    ].filter(Boolean).join(' ');
  }

  // --- a drink lying on the ground: not offered. Answered 5 times in all the
  // recorded runs; to come back as one option that runs clear of the enemy
  // first and drinks there (the walk-over version is in git before 2026-09-29).

  // --- the things that are always available
  // Movement is a gear as well as a direction. The game reads a run only from a
  // double-tap, so running is a separate choice: it covers ground about twice as
  // fast, but commits to the direction, where walking can be revised every tick.
  // Offered once the distance is long enough that walking would be slow, and
  // out to a run when there is ground to cover to break off.
  if (hasTarget && nearest > RUN_IN_MIN_X) {
    options.run_in = 'Run at the enemy — double-tap toward it. It closes ground about twice as fast as walking, but the direction is committed for the burst.';
  }
  if (hasTarget && nearest <= RUN_OUT_MAX_X && roomBehind >= RUN_OUT_ROOM) {
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
  if (roomBehind >= WALK_OUT_ROOM) {
    options.open_distance = 'Move away from the enemy, walking, to get out of its reach. Nothing is committed, so it can be changed at any moment.';
  }
  // Blocking is only offered while a swing is live or a weapon is inbound. A
  // guard held against an idle enemy wears down for nothing (73 defend ticks
  // with the enemy more than 120 away in one run), and offered whenever the
  // enemy stood close, Henry blocked in melee range with a free melee attack
  // on the list, which the observer marked. A swing that does start is the
  // reflex's to block.
  // The two defences are described against each other, because each is right
  // where the other is wrong: the block is instant but finite and leaves you
  // where you stand, the roll takes a moment to start but nothing gets through
  // it and it ends out of reach.
  if (threatened || weaponInbound) {
    options.defend = 'Block what is coming. It goes up at once, so it is the answer to something about to land, and it stops thrown stars, arrows and most swings from the front; it drops by itself once nothing is coming. But you stay where you are, heavy hits that knock you down go through it, and it breaks after several blocked hits in a row.'
      + (guardWorn ? ' Your guard is worn from the hits just taken: the next blocked hit breaks it, and the one after that lands in full while you stagger.' : '');
  }
  // A roll has no hurt box for its whole length, so it is the one answer that
  // takes no damage at all. It is reached from a run, which is why it cannot
  // answer a weapon that is about to land.
  // The roll carries about 200, so against the edge of the stage it ends in
  // the corner rather than out of reach (seen by the observer on both sides).
  // Not from an enemy on the floor or in the air with nothing coming: that is
  // a window to hit it (observer: "two unnecessary rolls", one of them from a
  // knocked-down Freeze 7 away, 2026-09-25T11-59-36).
  // Proximity alone used to offer it too: 19 of 46 rolls across four games had
  // nothing coming (2026-09-27, notes.jsonl). Offered like the block now, on
  // an actual threat rather than range, so Jev only spends a pick on it when
  // something is coming.
  if (hasTarget && roomBehind >= ROLL_ROOM && (threatened || weaponInbound)
      && !(targetDown && !threatened && !weaponInbound)) {
    options.roll_away = [
      'Roll away from the enemy: a short run, then a tumble along the ground. Nothing can hit you during the tumble and nothing breaks it, and you end about 200 further away, out of its reach.',
      'It takes about a third of a second to start, so it is for an enemy that is close or pressing you, not for a weapon about to land.',
      // Inside 90, 20% of 387 rolls since 09-24 were hit before the tumble
      // began (9% at 91-160), about 8 hp a try. Still the cheaper way out:
      // over the next 1.5 s a roll lost 16.5 hp there, a block 27, a wait 24.
      // Said without the second sentence, replayed on 146 old decisions,
      // rolls fell from 31% to 9% and blocks doubled; with it, 26%.
      nearest <= 90 ? 'The enemy is inside punching range. About one roll in five is caught before the tumble starts, since its punch is quicker than the run-up, but rolling here still costs less than blocking or waiting.' : '',
      'You cannot attack or block until it finishes.',
    ].filter(Boolean).join(' ');
  }
  options.wait = 'Hold position and do nothing this instant.';

  // An enemy drinking is the one window that pays twice: it cannot answer, and
  // every tick left alone is health back (Rudolf drank from 386 to 500 in one
  // run while Henry waited and shot from 350). With nothing coming at us, the
  // passive answers are closed so the choice is only how to hit it.
  if (enemyDoing === 'drinking' && !threatened && !weaponInbound) {
    for (const passive of ['wait', 'defend', 'open_distance', 'roll_away']) delete options[passive];
  }

  return options;
}

/**
 * How far a projectile carries, and what it would do from here. A move with no
 * range keeps its hit at any distance; a short-lived one is described band by
 * band, which is what separates Henry's blastpush (80, but only up close) from
 * his super arrow (50 at any distance) once they are side by side.
 */
function reachText(move, distance) {
  // Adding "an enemy free and facing you blocks it" cut Dennis's chase ball
  // from about a quarter of its offers to one in twelve, and Freeze ended at
  // 164 and 487 against 171 and 186 without it.
  if (move.homes) return 'Attack from where you stand. It flies until it hits, steers itself to the enemy so it needs no lining up, and does the same damage at any distance.';
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
 * Time from a move's first key to its hit: a special's three presses (and any
 * follow-up), PRESS_EVERY apart, then its wind-up. Henry's five arrows take
 * about 0.6 s where his plain arrow takes about 0.3 s, and the observer saw
 * the difference; the enemy can act, and hit him, in between.
 */
export function fireTicks(move) {
  const presses = move.category === 'special' ? 3 + (move.followUp?.length ?? 0) : 1;
  // A jump attack first rises for JUMP_RISE_TICKS (the executor's 220 ms).
  const rise = move.input === 'j+a' ? JUMP_RISE_TICKS : 0;
  return rise + (presses - 1) * PRESS_EVERY + (move.hitTicks ?? move.startupTicks ?? 0);
}
const JUMP_RISE_TICKS = 7;
const fireText = (move) => `It goes off about ${(fireTicks(move) / 30).toFixed(1)} s after the first key press.`;

/**
 * What pressing Attack again while it fires adds, from the move's own frames
 * (see `volleyOf` in profile.mjs): Dennis's energy ball goes on to four balls
 * for 150 MP, Henry's five arrows and Rudolf's stars repeat for as long as MP
 * lasts. Told as a single 30 that only staggers, Dennis's energy ball was
 * picked 0 times in 506 offers next to his 65 chasing ball.
 */
function volleyText(move) {
  const v = move.volley;
  if (!v) return '';
  const hits = [...new Set(v.shots.map((s) => s.damage))].sort((a, b) => a - b);
  const each = hits.length === 1 ? `${hits[0]}` : `${hits[0]}-${hits.at(-1)}`;
  const sec = (ticks) => (ticks / 30).toFixed(1);
  if (v.loopShots) {
    return `Pressing Attack again while it fires repeats it for as long as the MP lasts: each round is ${v.loopShots === 1 ? 'one more shot' : `${v.loopShots} more shots`} of ${each} for ${v.loopMp} MP and takes about ${sec(v.loopTicks)} s.`;
  }
  const first = v.shots.filter((s) => s.mp === move.mp).length;
  const span = v.shots.at(-1).tick - v.shots[0].tick;
  return `Pressing Attack again while it fires keeps it going: ${v.shots.length} shots of ${each} in all, over about ${sec(span)} s, for ${v.shots.at(-1).mp} MP (${first === 1 ? 'the first shot' : `the first ${first}`} alone ${move.mp}).`;
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

/** What a special that deals no measured damage does, from `effectOf` in profile.mjs. */
const UTILITY_TEXT = {
  heal_self: () => 'Heal yourself: you stand still while it plays and get health back.',
  heal_ally: () => 'Heal an ally: it sends healing to a fighter on your side.',
  teleport_to_enemy: () => 'Vanish and reappear right next to the enemy.',
  teleport_to_ally: () => 'Vanish and reappear next to an ally.',
  transform: () => 'Transform into another fighter for a while.',
  lift: () => 'Lift the enemies in front of you into the air and hold them there while it plays: it does almost no damage itself, but they cannot act until it ends.',
  grab: () => 'Grab an enemy within reach and throw it.',
  clone: () => 'Create copies of yourself that fight on your side.',
  weapon: () => 'Make a weapon in your hands to fight with.',
  unknown: (move) => `The game calls this move "${move.name}"; the game data does not show what it does.`,
};

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
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export const plainName = (...names) => {
  for (const n of names) if (n && FRIENDLY[n]) return FRIENDLY[n];
  for (const n of names) if (n) return n;
  return 'item';
};
