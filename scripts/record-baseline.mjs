/**
 * Records a match without touching it.
 *
 * Two jobs at once, both free: it produces the COM's own telemetry, which is
 * the baseline every later Jev run is measured against, and it captures every
 * numeric field on every fighter over time, which is what identifies HP, MP and
 * dark HP without having to press a single button — MP climbs on its own, dark
 * HP drifts toward HP, HP only moves when something lands.
 *
 * It also answers the question the executor's design depends on: how long does
 * one pool read actually take over CDP. If the answer is 30 ms, a 30 Hz loop is
 * a fiction and the tick rate has to come down.
 *
 *   node scripts/record-baseline.mjs --seconds 90 [--hz 30]
 */

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool, fighters } from '../src/state/entities.mjs';
import { openRun } from '../src/telemetry/log.mjs';
import { arg } from '../src/cli.mjs';

const seconds = Number(arg('seconds', 60));
// A pool read costs 3 ms, so an unlimited loop samples at ~260 Hz and writes
// 125 MB a minute to record a game that only advances 30 times a second.
const hz = Number(arg('hz', 30)); // --hz 0 removes the cap
const label = arg('label', 'com-baseline');

const cdp = await connect();
const pool = await openEntityPool(cdp);

// Nothing is worth recording until a fight exists.
process.stdout.write('waiting for fighters');
let live = [];
while (fighters(live).length < 2) {
  live = await pool.read();
  process.stdout.write('.');
  await sleep(500);
}
console.log(` ${fighters(live).length} in play: ${fighters(live).map((f) => f.name).join(', ')}`);

const run = openRun({
  meta: { label, purpose: 'baseline + field calibration', seconds, hz,
          fighters: fighters(live).map((f) => ({ slot: f.slot, name: f.name })) },
});

const latencies = [];
const track = new Map(); // "slot.field" -> { min, max, first, last, rises, falls }
const until = Date.now() + seconds * 1000;
let tick = 0;

while (Date.now() < until) {
  const t0 = performance.now();
  const entities = await pool.read();
  latencies.push(performance.now() - t0);

  const fs = fighters(entities);
  run.tick({
    tick: tick++,
    fighters: fs,
    // everything that is not a fighter, trimmed: weapons, projectiles, debris
    others: entities.filter((e) => e.type !== 0)
      .map((e) => ({ slot: e.slot, name: e.name, type: e.type, x: e.x, y: e.y, z: e.z })),
  });

  for (const f of fs) observe(f);
  if (hz) await sleep(Math.max(0, 1000 / hz - (performance.now() - t0)));
}

/** Per-field movement, which is what tells HP from MP from dark HP. */
function observe(f) {
  for (const [k, v] of Object.entries(f)) {
    if (typeof v !== 'number') continue;
    const id = `${f.slot}.${k}`;
    let s = track.get(id);
    if (!s) track.set(id, (s = { name: f.name, field: k, min: v, max: v, first: v, rises: 0, falls: 0 }));
    if (s.last !== undefined) {
      if (v > s.last) s.rises++;
      else if (v < s.last) s.falls++;
    }
    s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.last = v;
  }
}

const manifest = await run.close({ latencyMs: stats(latencies) });
await cdp.close();

console.log(`\n${tick} ticks in ${seconds}s → ${run.dir}`);
console.log(`pool read: p50 ${stats(latencies).p50} ms, p95 ${stats(latencies).p95} ms, max ${stats(latencies).max} ms`);
console.log(`sustainable tick rate: ~${Math.floor(1000 / stats(latencies).p95)} Hz\n`);

// Only the fields that moved are candidates; the constant ones are caps and ids.
const moved = [...track.values()].filter((s) => s.min !== s.max);
console.log('fields that changed during the run:');
console.log('  fighter        field     min      max     first     last   rises  falls');
for (const s of moved.sort((a, b) => a.field.localeCompare(b.field))) {
  console.log(`  ${s.name.padEnd(12)} ${s.field.padEnd(8)} ${pad(s.min)} ${pad(s.max)} ${pad(s.first)} ${pad(s.last)} ${String(s.rises).padStart(6)} ${String(s.falls).padStart(6)}`);
}
console.log(`\n${[...track.values()].length - moved.length} fields never changed (caps, ids, flags).`);
console.log(`manifest: ${manifest.counts.ticks} tick rows`);

function pad(n) { return String(Math.round(n * 100) / 100).padStart(8); }
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => Math.round(s[Math.floor(s.length * q)] ?? 0);
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: Math.round(s.at(-1) ?? 0) };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
