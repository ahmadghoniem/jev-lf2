/**
 * Which line to stand on, asked beside the action as a second decision.
 *
 * Moving in, backing off and holding all used to end level with the enemy,
 * because that is the only depth a shot or a swing connects from. It is also
 * the only depth the enemy's straight attacks and thrown weapons connect
 * from, and most of the damage in the runs arrived there. The game's own CPU
 * only starts an attack when the target is nearly on its line (5 of depth for
 * a swing, read from px.js), so standing off it and stepping on only to fire
 * is a real choice with a real price, and Jev makes it.
 *
 * Asked every decision in the same request; used only when the chosen action
 * is one of `LINE_ACTIONS`, which then runs as `<action>@off`.
 */

export const LINE_ACTIONS = ['close_distance', 'open_distance', 'wait'];

/** Depth kept from the enemy's line: past the 20 a star passes at, with room to spare. */
export const OFF_LINE = 30;

/** The follow-up, when an action it applies to is on offer. */
export function lineQuestion(options, arena) {
  if (!arena.threats.length || !LINE_ACTIONS.some((a) => a in options)) return {};
  return {
    line: {
      type: 'choice',
      instructions: 'If you move or hold position now rather than attack, which line do you stand on?',
      criteria: {
        on_line: 'Level with the enemy, on its line. Everything you fire or swing needs this, and so does everything it throws or swings at you.',
        off_line: `About ${OFF_LINE} units of depth off the enemy's line, above or below it. Its straight attacks and thrown weapons pass you by, and the computer starts its attacks only when you are almost exactly on its line; you step back on only to fire, which costs about half a second of walking.`,
      },
    },
  };
}

/** The action to run: a movement answered off the line gets the `@off` form. */
export const withLine = (action, answers) =>
  (LINE_ACTIONS.includes(action) && answers?.line?.choice === 'off_line' ? `${action}@off` : action);

/** The option an action name was built from. */
export const baseAction = (action) => (typeof action === 'string' ? action.split('@')[0] : action);
