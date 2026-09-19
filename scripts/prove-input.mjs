/**
 * Proves the harness can actually drive a fighter, not just a menu.
 *
 * Menus accept a key and move a cursor; that says nothing about whether the
 * game's input sampler sees a synthetic key during a fight, where input is read
 * per frame rather than on an event. So each check here presses a key and reads
 * the consequence out of the entity pool — position for movement, height for a
 * jump, the current frame id for an attack.
 *
 * Needs a match already running, with the harness slot alive.
 *
 *   node scripts/prove-input.mjs --name Deep
 */

import { readFileSync } from 'node:fs';
import { connect } from '../src/cdp/client.mjs';
import { openEntityPool, fighters } from '../src/state/entities.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

const KEYS = { up: 'F13', down: 'F14', left: 'F15', right: 'F16', attack: 'F17', jump: 'F18', defend: 'F19' };
const wanted = arg('name', 'Deep').toLowerCase();

const cdp = await connect();
const pool = await openEntityPool(cdp);

const me = async () => fighters(await pool.read()).find((f) => f.name?.toLowerCase() === wanted);
const start = await me();
if (!start) throw new Error(`${wanted} is not in play — start a match with that fighter first`);

const profile = JSON.parse(readFileSync('build/_profiles.json', 'utf8'))[wanted];
const attackFrames = new Set(profile.moves.filter((m) => m.kind === 'melee').map((m) => m.entry));

console.log(`driving ${start.name} in slot ${start.slot}, keys ${Object.values(KEYS).join(' ')}\n`);

const results = [];
await check('walk left', KEYS.left, 600, (s) => delta(s, 'x') < -10, (s) => `x moved ${delta(s, 'x').toFixed(0)}`);
await check('walk right', KEYS.right, 600, (s) => delta(s, 'x') > 10, (s) => `x moved ${delta(s, 'x').toFixed(0)}`);
await check('jump', KEYS.jump, 250, (s) => Math.min(...s.map((f) => f.y)) < -5,
  (s) => `peak height ${Math.min(...s.map((f) => f.y)).toFixed(0)}`);
await check('attack', KEYS.attack, 400, (s) => s.some((f) => attackFrames.has(f.Ts)),
  (s) => `frames ${[...new Set(s.map((f) => f.Ts))].join(',')}`);
await check('defend', KEYS.defend, 400, (s) => s.some((f) => f.Ts !== start.Ts),
  (s) => `frames ${[...new Set(s.map((f) => f.Ts))].join(',')}`);

console.log('\n  check        result   detail');
for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.pass ? 'PASS  ' : 'FAIL  '}   ${r.detail}`);
console.log(results.every((r) => r.pass)
  ? '\nInput injection drives the character. Phase 0 item 3 is done.'
  : '\nSomething did not land — a FAIL here means the fighter never reacted, not that the key was wrong.');

await cdp.close();

function delta(s, field) { return s.at(-1)[field] - s[0][field]; }

/**
 * A fighter that is lying down, getting up or reeling ignores input, and a COM
 * will knock the test subject over mid-run. Frames 0-15 are the standing,
 * walking and running blocks; anything above that is a state the character has
 * to come out of first.
 */
async function ready(timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const f = await me();
    if (f && f.Ts <= 15) return f;
  }
  return null;
}

/** Presses a key while sampling the pool, so the reaction is caught mid-press. */
async function check(name, code, holdMs, pass, detail) {
  const before = await ready();
  if (!before) { results.push({ name, pass: false, detail: 'never became actionable — knocked down the whole time' }); return; }
  const samples = [];
  const sampling = (async () => {
    const until = Date.now() + holdMs + 400;
    while (Date.now() < until) {
      const f = await me();
      if (f) samples.push(f);
    }
  })();
  await cdp.key(code, { holdMs });
  await sampling;
  const s = [before, ...samples];
  results.push({ name, pass: pass(s), detail: detail(s) });
}

