/**
 * Options of the same kind asked as one decision, then which one.
 *
 * Offered side by side, alternatives of one kind split between them the
 * weight Jev gives that kind: two specials, two drinks or three weapons each
 * come out smaller than a single option they compete with. So the action
 * question offers the kind once, and a second question, asked in the same
 * request, picks between its members. A kind with one member is offered
 * as that member.
 */

export const GROUPS = [
  { name: 'special_move', match: (o) => o.startsWith('special_'),
    text: 'Fire one of your special moves; which one is chosen separately.',
    which: 'If you fire a special move now, which one?' },
  { name: 'melee_attack',
    match: (o) => ['dash_attack', 'run_attack', 'jump_attack', 'rush_attack', 'punch'].includes(o)
      || /^(swing|jump_swing|run_swing|dash_swing)_/.test(o),
    text: 'Hit the enemy with a close-range attack; which one is chosen separately.',
    which: 'If you attack up close now, which attack?' },
  { name: 'pick_up_weapon', match: (o) => o.startsWith('pick_up_'),
    text: 'Pick up a weapon lying on the ground; which one is chosen separately.',
    which: 'If you pick up a weapon now, which one?' },
  { name: 'drink', match: (o) => o.startsWith('drink_'),
    text: 'Drink something lying on the ground; which one is chosen separately.',
    which: 'If you drink now, which one?' },
];

const which = (group) => `which_${group}`;
const firstSentence = (text) => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;

/**
 * @param options  option name -> description, as built by buildOptions
 * @returns {{ top: object, groups: object }} the action question's criteria,
 *   and for each grouped kind its member options
 */
export function nestOptions(options) {
  const top = {};
  const groups = {};
  for (const [name, text] of Object.entries(options)) {
    const group = GROUPS.find((g) => g.match(name));
    if (group) (groups[group.name] ??= {})[name] = text;
    else top[name] = text;
  }
  for (const [name, members] of Object.entries(groups)) {
    const names = Object.keys(members);
    if (names.length === 1) {
      top[names[0]] = members[names[0]];
      delete groups[name];
      continue;
    }
    const group = GROUPS.find((g) => g.name === name);
    // Each member by its first sentence, which says what it does and where it
    // reaches; the follow-up carries the full descriptions.
    top[name] = [group.text, ...names.map((n) => `${n}: ${firstSentence(members[n])}`)].join(' ');
  }
  return { top, groups };
}

/** The follow-up questions, one per grouped kind. */
export function followUps(groups) {
  return Object.fromEntries(Object.entries(groups).map(([name, members]) => [which(name), {
    type: 'choice',
    instructions: GROUPS.find((g) => g.name === name).which,
    criteria: members,
  }]));
}

/** The option actually chosen: a grouped kind resolves to its follow-up's pick. */
export function resolveChoice(choice, answers, groups) {
  const members = groups[choice];
  if (!members) return choice;
  const picked = answers?.[which(choice)]?.choice;
  return picked in members ? picked : Object.keys(members)[0];
}
