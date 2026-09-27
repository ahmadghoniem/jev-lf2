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

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { keyboard, readBindings } from '../src/executor/keyboard.mjs';
import { runLoop } from '../src/executor/loop.mjs';
import { heuristicPolicy, jevPolicy, forcePolicy } from '../src/executor/policies.mjs';
import { profileFor } from '../src/lf2data/tables.mjs';
import { openRun } from '../src/telemetry/log.mjs';
import { menuState, DIFFICULTY } from '../src/executor/setup.mjs';
import { createClient } from '../src/jev/client.mjs';
import { startMatch } from '../src/executor/match.mjs';
import { createOverlay } from '../src/executor/overlay.mjs';
import { proveInput, reportProbe } from '../src/executor/inputcheck.mjs';
import { arg, has, loadApiKey } from '../src/cli.mjs';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';

const name = arg('name', 'Deep');
const kind = arg('policy', 'heuristic');
const seconds = Number(arg('seconds', 60));
const hz = Number(arg('hz', 30));
const decideEveryMs = Number(arg('decide-ms', 500));
const staleMs = Number(arg('stale-ms', 1500));

const profile = profileFor(name);
if (!profile) throw new Error(`no profile for ${name}`);

// One harness per game. A batch stopped from outside left its play.mjs
// running, a second one started beside it, and both drove Henry at once
// (2026-09-25T04-25-34 and 04-25-35; 04-27-43 had two writers in one run).
const LOCK = 'runs/.play.lock';
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
  if (alive && pid !== process.pid) {
    console.error(`another play.mjs (pid ${pid}) is already driving the game; stop it first`);
    process.exit(3);
  }
}
mkdirSync('runs', { recursive: true });
writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { if (Number(readFileSync(LOCK, 'utf8')) === process.pid) unlinkSync(LOCK); } catch { /* already gone */ } });

let policy;
let client = null;
if (kind === 'jev') {
  loadApiKey();
  client = createClient();
  policy = jevPolicy(client, profile, { deadlineMs: Number(arg('deadline-ms', 1400)) });
} else if (kind === 'force') {
  policy = forcePolicy(arg('move', 'shoot'));
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

// Everything that can be done before the fight starts is done now: the panel
// goes up, and the connection to Jev is opened while the match loads and the
// input is checked, so the first decision is a warm one.
const overlay = createOverlay(cdp, { enabled: !has('no-overlay') });
await overlay.install();
const warming = client?.warm().then((ms) => console.log(`jev warm in ${ms} ms`)).catch(() => {});

// --fresh restarts the match first, so a run is never half a corpse.
if (has('fresh')) {
  const alive = await startMatch(cdp, pool, { attack: keys.attack });
  if (!alive) throw new Error('could not start a fresh match');
  console.log(`fresh match: ${alive.map((f) => f.name).join(', ')}`);
}

// A run is only worth its credit if the fighter is actually listening. A wrong
// key map is invisible in the telemetry — every action is logged as intended —
// so the only honest gate is to press a key and read the game's reaction.
if (!has('no-verify')) {
  const results = await proveInput({ cdp, pool, name, keys, gateOnly: true });
  const gate = results.find((r) => r.gate);
  if (gate?.status !== 'pass') reportProbe(results);
  if (gate?.status === 'fail') {
    throw new Error(`input injection failed for ${name} — the fighter never attacked, refusing to spend a run`);
  }
  if (gate?.status === 'inconclusive') {
    console.warn(`warning: could not prove input (${gate.detail}) — the run below is unverified`);
  }
}

await warming;

const level = (await menuState(cdp).catch(() => null))?.difficulty;
const difficulty = Object.keys(DIFFICULTY).find((k) => DIFFICULTY[k] === level) ?? 'unknown';
const run = openRun({ meta: { label: arg('label', `${kind}-${name}`), policy: kind, character: name,
                              archetype: profile.archetype, difficulty, hz, decideEveryMs, seconds } });

console.log(`${name} (${profile.archetype}) under ${kind} on ${difficulty}, ${seconds}s → ${run.dir}`);
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
  noSync: has('no-sync'),
  onTick: ({ arena, action, source }) => {
    const line = `${source.padEnd(9)} ${action.padEnd(24)} hp ${String(arena.me.hp).padStart(4)}  mp ${String(arena.me.mp).padStart(4)}  nearest ${Math.round(arena.nearest)}`;
    if (line !== lastShown) { console.log(line); lastShown = line; }
  },
});

await kb.releaseAll();
if (!has('keep-overlay')) await overlay.remove();
// The newest earlier run that recorded which Jev answered, to say when it changed.
const lastModels = () => {
  for (const d of readdirSync('runs').filter((d) => /^\d{4}-/.test(d)).sort().reverse()) {
    const f = `runs/${d}/manifest.json`;
    if (d === run.id || !existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8')).jev?.models;
    if (m && Object.keys(m).length) return m;
  }
  return null;
};
const before = client ? lastModels() : null;
const models = client ? { ...client.usage.models } : null;
const manifest = await run.close({ loop: counts, ...(client && { jev: { models } }) });
await cdp.close();

console.log(`\n${counts.ticks} ticks, ${counts.decisions} decisions, ${counts.misses} missed, `
  + `${counts.stale} stale, ${counts.reflexes} reflex ticks, ${counts.bursts} bursts, ${counts.dead} dead ticks, `
  + `${counts.defused} specials defused, ${counts.unshouted} shouts prevented — ${counts.outcome}`);
console.log(`run: ${run.dir} (${manifest.counts.judgements} judgement rows)`);
if (counts.timing) console.log(`loop: ${JSON.stringify(counts.timing)}`);
if (models) {
  const names = (m) => Object.keys(m).sort().join(', ');
  console.log(`jev: ${Object.entries(models).map(([k, n]) => `${k} (${n})`).join(', ') || 'no answers'}`);
  if (before && Object.keys(models).length && names(before) !== names(models)) {
    console.log(`JEV CHANGED: ${names(before)} → ${names(models)} — compare with: node scripts/replay-jev.mjs --n 200`);
  }
}
// Anything that could hurt, moved in play, and was never read.
const blind = counts.coverage?.blind ?? [];
console.log(blind.length
  ? `BLIND SPOTS: ${blind.map((b) => `${b.name} (type ${b.type}, ${b.notOurs} ticks unread, first at tick ${b.firstTick})`).join('; ')}`
  : 'blind spots: none');
