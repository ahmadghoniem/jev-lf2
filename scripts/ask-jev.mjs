/**
 * Builds the option set for one situation and asks Jev to choose, so the whole
 * path — profile, weapon tables, option wording, API — can be exercised without
 * a running match.
 *
 *   node scripts/ask-jev.mjs                      # Henry, enemy far, bat nearby
 *   node scripts/ask-jev.mjs --character bandit
 *   node scripts/ask-jev.mjs --held 121           # holding the baseball bat
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, choice, noul } from '../src/jev/client.mjs';
import { buildOptions } from '../src/state/options.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

if (!process.env.TYPESAFE_API_KEY) {
  const env = readFileSync(join(ROOT, '.env'), 'utf8').match(/TYPESAFE_API_KEY=(.+)/);
  if (env) process.env.TYPESAFE_API_KEY = env[1].trim();
}

const profiles = JSON.parse(readFileSync(join(ROOT, 'build/_profiles.json'), 'utf8'));
const weapons = JSON.parse(readFileSync(join(ROOT, 'build/_weapons.json'), 'utf8'));

const character = arg('character', 'henry');
const profile = profiles[character];
if (!profile) { console.error(`no profile for ${character}; have ${Object.keys(profiles).join(' ')}`); process.exit(1); }

const heldId = arg('held');
const held = heldId ? { id: Number(heldId), name: weapons[heldId]?.name } : null;
const nearest = Number(arg('nearest', 380));

const options = buildOptions({
  profile,
  weapons,
  held,
  nearest,
  mp: 500,
  hp: Number(arg('hp', 500)),
  hpMax: 500,
  nearby: [
    { id: 121, name: 'weapon5', type: 4, distance: 150, contested: false },
    { id: 122, name: 'weapon6', type: 6, distance: 620, contested: false },
  ],
});

const state = {
  me: { character: profile.name, archetype: profile.archetype, hp: 'healthy', mp: 'full',
        holding: held ? weapons[heldId]?.name ?? 'a weapon' : 'none', stance: 'standing', facing: 'right' },
  threats: [{ id: 'e1', distance: 'one_dash', side: 'front', doing: 'approaching', hp: 'healthy' }],
};

console.log(`${profile.name} — ${profile.archetype}, bare reach ${profile.meleeReach}, enemy ${nearest} away\n`);
for (const [k, v] of Object.entries(options)) console.log(`  ${k}\n      ${v}`);

const jev = createClient();
const answer = await jev.ask({
  state,
  deadlineMs: 5000,
  questions: {
    action: choice('Choose what this fighter should do right now. Prefer the option that does the most damage for the risk it takes, given where the enemy is.', options),
    commit: noul('Should this fighter commit to an attack this instant?', {
      true: 'Attacking now is unlikely to be punished.',
      false: 'Attacking now is likely to be punished.',
    }),
  },
});

if (!answer) { console.log('\nno answer within the deadline'); process.exit(0); }
const a = answer.answers.action;
const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 5);
console.log(`\nchose ${a.choice} (confidence ${a.confidence})`);
console.log(`  ${ranked.map(([k, v]) => `${k} ${v}`).join('   ')}`);
console.log(`  commit ${answer.answers.commit.noul}`);
console.log(`\n${answer.latencyMs}ms, ${answer.usage.input_tokens} input tokens, est $${jev.costUsd.toFixed(6)}`);
