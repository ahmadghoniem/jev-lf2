/**
 * Samples the fighters' fields over time so obfuscated names can be pinned to
 * meanings by how they behave.
 *
 *   node scripts/watch-fields.mjs [seconds] [hz]
 *
 * Prints, per fighter, every field that moved: how often, its range, and the
 * first few values. HP falls in steps, MP regenerates smoothly, a frame id
 * jumps around inside the character's own frame table.
 */
import { connect } from '../src/cdp/client.mjs';
import { openEntityPool, fighters } from '../src/state/entities.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const seconds = Number(process.argv[2] ?? 6);
const hz = Number(process.argv[3] ?? 20);

const cdp = await connect();
const pool = await openEntityPool(cdp);

const series = new Map(); // "name#slot" -> { field -> values[] }
const ticks = Math.round(seconds * hz);
for (let i = 0; i < ticks; i++) {
  for (const f of fighters(await pool.read())) {
    const key = `${f.name}#${f.slot}`;
    if (!series.has(key)) series.set(key, new Map());
    const fields = series.get(key);
    for (const [k, v] of Object.entries(f)) {
      if (typeof v !== 'number' && typeof v !== 'boolean') continue;
      if (!fields.has(k)) fields.set(k, []);
      fields.get(k).push(v);
    }
  }
  await sleep(1000 / hz);
}

for (const [who, fields] of series) {
  console.log(`\n=== ${who} — ${ticks} samples over ${seconds}s ===`);
  const rows = [];
  for (const [k, vals] of fields) {
    const nums = vals.map(Number);
    let changes = 0;
    for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1]) changes++;
    if (changes === 0) continue;
    rows.push({
      k, changes,
      min: Math.min(...nums), max: Math.max(...nums),
      distinct: new Set(nums).size,
      head: nums.slice(0, 8).map((n) => Math.round(n * 10) / 10).join(','),
    });
  }
  rows.sort((a, b) => b.changes - a.changes);
  console.log('field      changes  distinct       min       max  first values');
  for (const r of rows) {
    console.log(`${r.k.padEnd(9)} ${String(r.changes).padStart(8)} ${String(r.distinct).padStart(9)} ${String(Math.round(r.min)).padStart(9)} ${String(Math.round(r.max)).padStart(9)}  ${r.head}`);
  }
  const constant = [...fields].filter(([, v]) => new Set(v.map(Number)).size === 1);
  console.log(`\nconstant: ${constant.map(([k, v]) => `${k}=${v[0]}`).join(' ')}`);
}
cdp.close();
