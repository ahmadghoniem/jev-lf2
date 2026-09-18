/**
 * Prints every entity currently in play.
 *
 *   node scripts/entity-dump.mjs             # one line each
 *   node scripts/entity-dump.mjs --full      # every field of every fighter
 */
import { connect } from '../src/cdp/client.mjs';
import { openEntityPool, fighters } from '../src/state/entities.mjs';

const cdp = await connect();
const pool = await openEntityPool(cdp);
const live = await pool.read();

console.log(`${live.length} entities in play, ${fighters(live).length} of them fighters\n`);
for (const e of live) {
  console.log(`slot ${String(e.slot).padStart(3)}  ${String(e.name).padEnd(16)} id ${String(e.id).padEnd(4)} type ${e.type}  (${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)})`);
}

if (process.argv.includes('--full')) {
  for (const f of fighters(live)) {
    console.log(`\n=== ${f.name} (slot ${f.slot}) ===`);
    const entries = Object.entries(f).filter(([k]) => !['name', 'filename', 'id', 'type', 'slot'].includes(k));
    console.log(entries.map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`).join(' '));
  }
}
cdp.close();
