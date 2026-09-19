/**
 * The two things that can be sitting in the decision seat.
 *
 * They answer the same question and get logged the same way, which is the
 * whole point: the heuristic is the control arm. If Jev does not clearly beat
 * it, the harness is doing the work and the result means nothing.
 */

import { buildOptions } from '../state/options.mjs';
import { semanticState } from '../state/arena.mjs';
import { weapons } from '../lf2data/tables.mjs';
import { executableOptions, planAction } from './actions.mjs';
import { wouldWhiff } from './reflex.mjs';

/** Options the executor can actually carry out, described for a reader. */
export function offer(arena, profile) {
  const options = buildOptions({
    profile,
    weapons,
    canDo: (name) => planAction(name, { arena, profile }) !== null,
    held: arena.held,
    nearby: arena.items.slice(0, 3).map((i) => ({ ...i, distance: i.range })),
    nearest: arena.nearest,
    mp: arena.me.mp,
    behind: arena.threats[0] ? !arena.threats[0].infront : false,
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
export function jevPolicy(client, profile, { deadlineMs = 900 } = {}) {
  return {
    name: 'jev',
    questions: questionSet,
    async decide({ arena, options, recent }) {
      const state = semanticState({ arena, profile, recent });
      const questions = questionSet(options, arena);
      const t0 = Date.now();
      const answer = await client.ask({ state, questions, deadlineMs });
      const latencyMs = Date.now() - t0;
      if (!answer) return { action: null, latencyMs, state, questions };
      return {
        action: answer.answers?.action?.choice ?? null,
        answers: answer.answers,
        usage: answer.usage,
        requestId: answer.requestId,
        latencyMs, state, questions,
      };
    },
  };
}

/** Independent questions, evaluated in parallel by the service. */
function questionSet(options, arena) {
  const questions = {
    action: {
      type: 'choice',
      instructions: 'Choose what to do next in this fight. Every option listed is available right now.',
      criteria: options,
    },
    commit: {
      type: 'noul',
      instructions: 'Is this the moment to commit to an attack rather than reposition?',
      criteria: {
        true: 'An enemy is close, is not about to hit you, and you can reach it.',
        false: 'You are out of range, recovering, or an enemy is winding up an attack at you.',
      },
    },
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
