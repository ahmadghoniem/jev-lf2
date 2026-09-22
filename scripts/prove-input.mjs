/**
 * Proves the harness can actually drive a fighter, not just a menu.
 *
 * Needs a match already running, with the harness slot in play.
 *
 *   node scripts/prove-input.mjs --name Davis
 *
 * Exits non-zero when a decisive check fails, so it can gate a run.
 */

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { readBindings } from '../src/executor/keyboard.mjs';
import { proveInput, reportProbe } from '../src/executor/inputcheck.mjs';
import { arg } from '../src/cli.mjs';

const name = arg('name', 'Deep');

const cdp = await connect();
const pool = await openEntityPool(cdp);
const keys = await readBindings(cdp, 'P4');

console.log(`driving ${name}, keys ${Object.values(keys).join(' ')}`);
const results = await proveInput({ cdp, pool, name, keys });
await cdp.close();

reportProbe(results);
console.log(results.every((r) => r.status !== 'fail')
  ? '\nInput injection drives the character.'
  : '\nSomething did not land — a FAIL here means the fighter never reacted, not that the key was wrong.');

process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
