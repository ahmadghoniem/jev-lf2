/**
 * Starts the next match with the same lineup.
 *
 *   node scripts/new-match.mjs [--attack F17] [--tries 8]
 */

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { startMatch } from '../src/executor/match.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

const cdp = await connect();
const pool = await openEntityPool(cdp);
const alive = await startMatch(cdp, pool, { attack: arg('attack', 'F17'), tries: Number(arg('tries', 8)) });
await cdp.close();

if (!alive) { console.log('no fresh match started — check the screen, a menu may be somewhere unexpected'); process.exit(1); }
console.log(`match running: ${alive.map((f) => `${f.name}(${f.hp})`).join(', ')}`);
