/**
 * Puts the harness in control of a fighter.
 *
 *   node scripts/play.mjs --name Deep  --policy heuristic --seconds 60
 *   node scripts/play.mjs --name Henry --policy jev       --seconds 120
 *
 * The heuristic policy costs nothing and is the control arm; `--policy jev`
 * spends credit. Either way the run lands in `runs/<id>/` with one tick row per
 * frame and one judgement row per decision, including the ones that missed.
 *
 * Needs a match already running with that fighter in the harness's slot, and
 * the slot's keys bound — see `scripts/bind-keys.mjs`.
 */

import { readFileSync } from 'node:fs';
import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { keyboard, readBindings } from '../src/executor/keyboard.mjs';
import { runLoop } from '../src/executor/loop.mjs';
import { heuristicPolicy, jevPolicy } from '../src/executor/policies.mjs';
import { profileFor } from '../src/lf2data/tables.mjs';
import { openRun } from '../src/telemetry/log.mjs';
import { createClient } from '../src/jev/client.mjs';
import { startMatch } from '../src/executor/match.mjs';
import { createOverlay } from '../src/executor/overlay.mjs';
import { proveInput, reportProbe } from '../src/executor/inputcheck.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

const name = arg('name', 'Deep');
const kind = arg('policy', 'heuristic');
const seconds = Number(arg('seconds', 60));
const hz = Number(arg('hz', 30));
const decideEveryMs = Number(arg('decide-ms', 500));
const staleMs = Number(arg('stale-ms', 1500));

const profile = profileFor(name);
if (!profile) throw new Error(`no profile for ${name}`);

let policy;
if (kind === 'jev') {
  if (!process.env.TYPESAFE_API_KEY) {
    const env = readFileSync('.env', 'utf8').match(/TYPESAFE_API_KEY=(.+)/);
    if (env) process.env.TYPESAFE_API_KEY = env[1].trim();
  }
  policy = jevPolicy(createClient(), profile, { deadlineMs: Number(arg('deadline-ms', 1400)) });
} else {
  policy = heuristicPolicy(profile);
}

const cdp = await connect();
const pool = await openEntityPool(cdp);
// Read the slot's real keys. Guessing them costs a whole run: the presses land
// nowhere, the fighter never moves, and the log still reports each action.
const keys = await readBindings(cdp, 'P4');
console.log(`P4 keys: ${Object.entries(keys).map(([s, k]) => `${s}=${k}`).join(' ')}`);
const kb = keyboard(cdp, keys);

// --fresh restarts the match first, so a run is never half a corpse.
if (process.argv.includes('--fresh')) {
  const alive = await startMatch(cdp, pool, { attack: keys.attack });
  if (!alive) throw new Error('could not start a fresh match');
  console.log(`fresh match: ${alive.map((f) => f.name).join(', ')}`);
}

// A run is only worth its credit if the fighter is actually listening. A wrong
// key map is invisible in the telemetry — every action is logged as intended —
// so the only honest gate is to press a key and read the game's reaction.
if (!process.argv.includes('--no-verify')) {
  const results = await proveInput({ cdp, pool, name, keys });
  const gate = results.find((r) => r.gate);
  if (gate?.status !== 'pass') reportProbe(results);
  if (gate?.status === 'fail') {
    throw new Error(`input injection failed for ${name} — the fighter never attacked, refusing to spend a run`);
  }
  if (gate?.status === 'inconclusive') {
    console.warn(`warning: could not prove input (${gate.detail}) — the run below is unverified`);
  }
}

const overlay = createOverlay(cdp, { enabled: !process.argv.includes('--no-overlay') });
await overlay.install();

const run = openRun({ meta: { label: arg('label', `${kind}-${name}`), policy: kind, character: name,
                              archetype: profile.archetype, hz, decideEveryMs, seconds } });

console.log(`${name} (${profile.archetype}) under ${kind}, ${seconds}s → ${run.dir}`);
console.log('ctrl-c releases the keys and closes the run\n');

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  await kb.releaseAll();
  await overlay.remove();
  await run.close();
  await cdp.close();
  process.exit(0);
};
process.on('SIGINT', stop);

let lastShown = '';
const counts = await runLoop({
  cdp, pool, kb, run, name, policy, overlay, hz, decideEveryMs, seconds, staleMs, keys,
  onTick: ({ arena, action, source }) => {
    const line = `${source.padEnd(9)} ${action.padEnd(24)} hp ${String(arena.me.hp).padStart(4)}  mp ${String(arena.me.mp).padStart(4)}  nearest ${Math.round(arena.nearest)}`;
    if (line !== lastShown) { console.log(line); lastShown = line; }
  },
});

await kb.releaseAll();
if (!process.argv.includes('--keep-overlay')) await overlay.remove();
const manifest = await run.close({ loop: counts });
await cdp.close();

console.log(`\n${counts.ticks} ticks, ${counts.decisions} decisions, ${counts.misses} missed, `
  + `${counts.stale} stale, ${counts.reflexes} reflex ticks, ${counts.bursts} bursts, ${counts.dead} dead ticks`);
console.log(`run: ${run.dir} (${manifest.counts.judgements} judgement rows)`);
