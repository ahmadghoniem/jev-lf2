/**
 * Asks today's Jev the questions it answered in recorded games, with the exact
 * state and options it saw, and reports how often it picks the same. Run it
 * when a game ends with "Jev changed": a shift in picks that the replay also
 * shows is the model's, not the harness's.
 *
 *   node scripts/replay-jev.mjs --n 200
 *   node scripts/replay-jev.mjs --n 200 --since 2026-09-27T09 --character Dennis
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { arg, readJsonl, loadApiKey } from '../src/cli.mjs';
import { createClient } from '../src/jev/client.mjs';
import { nestOptions, followUps, resolveChoice } from '../src/state/nest.mjs';

loadApiKey();
const N = Number(arg('n', 200));
const since = arg('since', '');
const character = arg('character', null);

const rows = [];
for (const r of readdirSync('runs').filter((d) => /^\d{4}-/.test(d) && d >= since).sort()) {
  const m = `runs/${r}/manifest.json`;
  if (!existsSync(m)) continue;
  const manifest = JSON.parse(readFileSync(m, 'utf8'));
  if (manifest.policy !== 'jev' || (character && manifest.character !== character)) continue;
  for (const j of readJsonl(`runs/${r}/judgements.jsonl`)) {
    const f = `runs/${r}/schema-${j.schema}.json`;
    if (j.answers && j.state && j.action && j.criteria?.action && existsSync(f)) rows.push({ j, f });
  }
}
// Spread over the whole set rather than the first N, so no one game dominates.
const step = Math.max(1, Math.floor(rows.length / N));
const sample = rows.filter((_, i) => i % step === 0).slice(0, N);
if (!sample.length) { console.log('no recorded Jev decisions match'); process.exit(0); }

const jev = createClient();
const was = {};
let same = 0, done = 0, failed = 0;
const shifts = {};
const models = {};
await Promise.all(sample.map(async ({ j, f }, idx) => {
  await new Promise((res) => setTimeout(res, idx * 40));
  const schema = JSON.parse(readFileSync(f, 'utf8'));
  const { top, groups } = nestOptions(j.criteria.action);
  const questions = { action: { ...schema.action, criteria: top }, ...followUps(groups) };
  try {
    const a = await jev.replay({ state: j.state, questions });
    const now = resolveChoice(a.answers?.action?.choice ?? null, a.answers, groups);
    done++;
    models[a.model ?? 'unknown'] = (models[a.model ?? 'unknown'] ?? 0) + 1;
    was[j.model ?? 'unrecorded'] = (was[j.model ?? 'unrecorded'] ?? 0) + 1;
    if (now === j.action) same++;
    else shifts[`${j.action} -> ${now}`] = (shifts[`${j.action} -> ${now}`] ?? 0) + 1;
  } catch (e) { failed++; console.error(e.message.slice(0, 120)); }
}));

console.log(`${done} decisions replayed of ${rows.length} recorded${failed ? `, ${failed} failed` : ''}`);
console.log(`recorded by: ${JSON.stringify(was)}  replayed by: ${JSON.stringify(models)}`);
console.log(`same pick: ${same} (${Math.round((100 * same) / Math.max(1, done))}%)`);
console.log('most common changes:');
for (const [k, n] of Object.entries(shifts).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k}: ${n}`);
