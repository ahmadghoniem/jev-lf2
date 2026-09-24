/**
 * The game plan, asked beside the action as a second decision.
 *
 * Each decision is otherwise made fresh, about one second of the fight, and
 * nothing ties one to the next: Jev could press on one answer and back off on
 * the next with nothing changed. The plan is the few seconds' intent the
 * action serves. It is answered in the same request as the action, so it
 * cannot shape that action; it is handed back on the next decision as
 * `recent.plan`, with how long it has held, and the action question is told
 * to carry it out.
 */

export const PLANS = {
  press: 'Stay close and keep hitting, so the enemy has no room to fire, run or rest. Best while it is hurt, out of MP, cornered or getting up.',
  keep_range: 'Stay at the distance your shots reach and its swings do not, and fire from there. Best when you out-range it.',
  bait: 'Stand just outside its reach to draw an attack, then hit it while it recovers. Best against an enemy that attacks on sight.',
  recover: 'Keep away and spend nothing until your MP is back for your specials. Best when your bar is low and the enemy is not about to reach you.',
};

/** The follow-up, asked while there is an enemy to plan against. */
export function planQuestion(arena) {
  if (!arena.threats.length) return {};
  return {
    plan: {
      type: 'choice',
      instructions: 'Which game plan should the next few seconds follow? '
        + 'Your plan so far is under recent.plan, with how long it has held and the hp it has won and lost. '
        + 'Choose afresh: keep it while it is working, and change it when it is not, for example when it deals little damage, or when the enemy\'s hp, MP or distance has changed.',
      criteria: PLANS,
    },
  };
}

/** Added to the action question: the action carries out the plan. */
export const PLAN_NOTE = ' If recent.plan is set, it is the game plan you chose a moment ago: pick the action that carries it out, unless the fight has changed.';

/**
 * Keeps the plan across answers, with the time it has held and the hp dealt
 * and taken since. Without a result to judge it by, a plan was kept all game:
 * one Davis run answered `bait` 129 times of 129 and dealt 215.
 */
export function createPlanMemory(now = () => Date.now()) {
  let plan = null;
  let since = 0;
  let start = null; // { me, foe: { slot, hp } } at the plan's start
  const hpOf = (arena) => ({ me: arena.me.hp, foe: arena.threats[0] && { slot: arena.threats[0].slot, hp: arena.threats[0].hp } });
  return {
    update(choice, arena) {
      if (!choice || !(choice in PLANS)) return;
      if (choice !== plan) { plan = choice; since = now(); start = arena ? hpOf(arena) : null; }
    },
    get current() { return plan; },
    recent(arena) {
      if (!plan) return {};
      const s = Math.round((now() - since) / 1000);
      if (!start || !arena) return { plan: `${plan.replace(/_/g, ' ')} (for ${s} s)` };
      const t = arena.threats.find((x) => x.slot === start.foe?.slot);
      const dealt = t ? Math.max(0, start.foe.hp - t.hp) : null;
      const taken = Math.max(0, start.me - arena.me.hp);
      return { plan: `${plan.replace(/_/g, ' ')} (for ${s} s; dealt ${dealt ?? 'unknown'} hp, taken ${taken} hp)` };
    },
  };
}
