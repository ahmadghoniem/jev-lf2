/**
 * The two things that can be sitting in the decision seat.
 *
 * They answer the same question and get logged the same way, which is the
 * whole point: the heuristic is the control arm. If Jev does not clearly beat
 * it, the harness is doing the work and the result means nothing.
 */

import { buildOptions } from '../state/options.mjs';
import { semanticState, doing, unhittable } from '../state/arena.mjs';
import { nestOptions, followUps, resolveChoice } from '../state/nest.mjs';
import { weapons } from '../lf2data/tables.mjs';
import { executableOptions, planAction } from './actions.mjs';
import { wouldWhiff, incoming, inboundWeapon, guardHolds, GUARD_BREAK } from './reflex.mjs';
import { standoffOf } from '../state/bot.mjs';

/** Below this much MP, spending it is flagged as a last resort. */
const MP_LOW = 100;

/** Whether the next blocked hit would break the guard. */
function guardWorn(arena) {
  const weapon = inboundWeapon(arena);
  return weapon ? !guardHolds(arena.me, weapon) : (arena.me.guard ?? 0) > GUARD_BREAK - 16;
}

/** Options the executor can actually carry out, described for a reader. */
export function offer(arena, profile) {
  const near = arena.threats[0];
  const options = buildOptions({
    profile,
    weapons,
    canDo: (name) => planAction(name, { arena, profile }) !== null,
    held: arena.held,
    // A weapon in flight is not a pickup — offering it as one invites a walk
    // straight down the line the weapon is travelling along.
    nearby: arena.items.filter((i) => !i.inFlight).slice(0, 3).map((i) => ({ ...i, distance: i.range })),
    nearest: arena.nearest,
    mp: arena.me.mp,
    hp: arena.me.hp,
    hpMax: arena.me.hpMax,
    behind: near ? !near.infront : false,
    vulnerable: near?.vulnerable ?? false,
    enemyDoing: near?.doing ?? null,
    aligned: near?.aligned ?? true,
    targetDown: unhittable(near),
    hasTarget: !!near,
    targetOnScreen: near?.onScreen ?? true,
    threatened: !!incoming(arena, { within: 12 }),
    helpless: !!near?.helpless,
    weaponInbound: !!inboundWeapon(arena),
    guardWorn: guardWorn(arena),
    roomBehind: roomBehind(arena),
  });
  return executableOptions(options, { arena, profile });
}

/**
 * Phase 0's stand-in: close, hit when in range, drink when badly hurt, back off
 * when hurt and the enemy is swinging. Deliberately simple — it is a baseline,
 * not a competitor.
 */
export function heuristicPolicy(profile) {
  const reach = profile?.basicAttack?.reach ?? 40;
  return {
    name: 'heuristic',
    questions: (options) => ({ action: { type: 'choice', instructions: 'heuristic', criteria: options } }),
    async decide({ arena, options }) {
      const hurt = arena.me.hp / (arena.me.hpMax || 500) < 0.35;
      const drink = Object.keys(options).find((o) => o.startsWith('drink_'));
      if (hurt && drink) return { action: drink };

      if (!wouldWhiff(arena, reach)) {
        const attack = ['dash_attack', 'punch', 'shoot', 'swing']
          .flatMap((p) => Object.keys(options).filter((o) => o === p || o.startsWith(`${p}_`)));
        if (attack.length) return { action: attack[0] };
      }
      if (arena.threats.length === 0) return { action: 'wait' };
      return { action: 'close_distance' };
    },
  };
}

/**
 * Jev in the seat. One attempt per decision with a hard deadline — a retry that
 * lands late answers a question about a fight that has moved on — and `null`
 * on a miss, which the loop treats as "keep doing what you were doing".
 */
export function jevPolicy(client, profile, { deadlineMs = 1400 } = {}) {
  return {
    name: 'jev',
    questions: (options, arena) => questionSet(options, arena, profile),
    async decide({ arena, options, questions = questionSet(options, arena, profile), recent }) {
      const state = semanticState({ arena, profile, recent });
      const t0 = Date.now();
      const answer = await client.ask({ state, questions, deadlineMs });
      const latencyMs = Date.now() - t0;
      if (!answer) return { action: null, latencyMs, state, questions };
      return {
        action: resolveChoice(answer.answers?.action?.choice ?? null, answer.answers,
          nestOptions(options).groups),
        answers: answer.answers,
        usage: answer.usage,
        requestId: answer.requestId,
        latencyMs, state, questions,
      };
    },
  };
}

/** Distance to the stage edge on the side away from the nearest enemy. */
function roomBehind(arena) {
  const near = arena.threats[0];
  if (!near) return Infinity;
  return near.x >= arena.me.x ? arena.me.x : (arena.stageWidth ?? Infinity) - arena.me.x;
}

/**
 * The situation notes appended to the action question, each only when it
 * holds. They say in words what the arena says in numbers.
 */
function situationNotes(options, arena, profile) {
  const near = arena.threats[0];
  const canShoot = Object.keys(options).some((o) => o === 'shoot' || o.startsWith('special_'));
  return [
    [near && !near.onScreen,
      'The enemy is off the screen, too far for any shot to land, so there is nothing to fire at until it is back on screen.'],
    [near?.doing === 'drinking',
      'The enemy is drinking to heal and cannot move, block or attack until it finishes. Every moment it drinks is health it gets back, so hit it now: a shot that reaches from here lands and stops the drink, and running in works if nothing you fire reaches.'],
    [near?.helpless && near.doing !== 'drinking',
      'An enemy is helpless right now — it cannot move or block — so a free hit is on the table.'],
    [near?.vulnerable && !near.helpless,
      'The enemy is at the tail end of an attack. It has nothing live, but it may have released a weapon a moment ago, so check the air before walking in.'],
    [near && !near.aligned,
      'You and the enemy are at different depths, so nothing fired from here will connect until you line up on its depth.'],
    [near?.aligned && canShoot && near.gap <= standoffOf(profile),
      'You are level with the enemy and inside your firing range, so the shot reaches from where you stand — holding this distance beats walking in, where it can hit back.'],
    [near && near.gap <= 80,
      'The enemy is inside punching range. Unless a swing is already coming, a block here only waits for its next hit: hitting it first is the faster answer at this distance, and rolling away gets you out of its reach.'],
    [near && near.gap <= 100 && Object.keys(options).some((o) => o === 'dash_attack' || o === 'run_attack'),
      'The enemy is close enough for your free melee attacks, which cost no MP; an arrow or a special spends MP even at this range.'],
    [near && roomBehind(arena) < 60,
      'Your back is to the edge of the stage, so there is no ground behind you to back away into; moving away only pins you in the corner. The way out is along the depth or past the enemy.'],
    [near?.approach,
      'The enemy is walking toward you, so it will close the gap on its own; there is nothing to gain by meeting it.'],
    [near && !near.approach && near.hasDest,
      'The enemy is holding or withdrawing rather than closing, so you may have to move to keep it inside your range.'],
    [doing(arena.me) === 'blocking',
      'You are holding a block. It absorbs a few hits and then breaks, so the moment the swing passes, answer with an attack rather than blocking again.'],
    [unhittable(near),
      'The enemy is on the floor or in the air, so nothing you fire can connect — spend no MP until it is back on its feet.'],
    [inboundWeapon(arena) && !guardWorn(arena),
      'A weapon that was thrown at you is still in the air and closing, so nothing you throw will stop it — block it, or roll away if it is still far enough off for the roll to start.'],
    [inboundWeapon(arena) && guardWorn(arena),
      'A weapon is closing on you and your guard is too worn to hold it: blocking breaks the guard and the next throw lands. Rolling, or hitting the thrower while it is throwing, ends the volley; standing in its line does not.'],
    [incoming(arena, { within: 12 }),
      'An enemy swing is already coming at you, so blocking or rolling away beats trading.'],
    [arena.me.mp < MP_LOW,
      'Your MP is nearly spent, so spend what is left only on a shot that will land.'],
  ].filter(([when]) => when).map(([, text]) => ` ${text}`).join('');
}

/**
 * Independent questions, evaluated in parallel by the service. Options of one
 * kind are offered once in the action question, and a follow-up per kind
 * picks between them in the same request (see `src/state/nest.mjs`).
 */
function questionSet(options, arena, profile) {
  const { top, groups } = nestOptions(options);
  const questions = {
    action: {
      type: 'choice',
      instructions: 'Choose what to do next in this fight. Every option listed is available right now.'
        + situationNotes(options, arena, profile),
      criteria: top,
    },
    ...followUps(groups),
  };
  if (arena.threats.length > 1) {
    questions.target = {
      type: 'choice',
      instructions: 'Which enemy should be the focus right now?',
      criteria: Object.fromEntries(arena.threats.slice(0, 3).map((t) => [`e${t.slot}`,
        `${t.name}, ${t.infront ? 'in front of you' : 'behind you'}.`])),
    };
  }
  return questions;
}
