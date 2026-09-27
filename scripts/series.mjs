/**
 * Several games in a row, each set up by `menu.mjs --setup` and played by
 * `play.mjs`. The first game walks the menus if the fighters differ from the
 * last match; every later one restarts with Esc then Enter on Fight!. Stops at
 * the first setup or game that fails, rather than trying the next one.
 *
 *   node scripts/series.mjs --fighter Henry --vs Rudolf --games 3
 *   node scripts/series.mjs --fighter Davis --vs Firen --games 3 --difficulty difficult --seconds 300
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { arg } from '../src/cli.mjs';

const fighter = arg('fighter', 'Henry');
const vs = arg('vs', 'Rudolf');
const games = Number(arg('games', 3));
const difficulty = arg('difficulty', 'difficult');
const seconds = arg('seconds', '300');
const policy = arg('policy', 'jev');
// Anything after a literal `--` on the command line is forwarded to play.mjs
// as-is, so a one-off flag (--no-recent, --stale-ms 700) can be tried across
// a whole series without a dedicated series.mjs option for it.
const passthroughAt = process.argv.indexOf('--');
const passthrough = passthroughAt === -1 ? [] : process.argv.slice(passthroughAt + 1);

const node = (script, args) => spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' }).status;
const latestRun = () => readdirSync('runs').filter((d) => /^\d{4}-/.test(d)).sort().at(-1);

const played = [];
for (let i = 1; i <= games; i++) {
  console.log(`\n=== game ${i} of ${games}: ${fighter} v ${vs}`);
  if (node('scripts/menu.mjs', ['--setup', '--fighter', fighter, '--vs', vs, '--difficulty', difficulty]) !== 0) {
    console.error('setup failed; stopping');
    break;
  }
  const before = latestRun();
  const status = node('scripts/play.mjs', ['--name', fighter, '--policy', policy, '--seconds', seconds, ...passthrough]);
  const after = latestRun();
  if (after !== before) played.push(after);
  if (status !== 0) { console.error(`play.mjs exited with ${status}; stopping`); break; }
}
console.log(`\nruns: ${played.join(' ') || 'none'}`);
