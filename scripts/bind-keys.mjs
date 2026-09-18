/**
 * Reads and rewrites the game's key bindings.
 *
 * The remaster keeps them in `localStorage` as one delimited string, which is
 * better than the rebinding screen for our purposes: the harness can give its
 * player slot keys that no physical keyboard has (F13–F24) without a human
 * holding down anything, and without the settings UI getting a say in whether
 * those keys are allowed.
 *
 * Slot order per player is fixed: up, down, left, right, attack, jump, defend,
 * then three unused. Confirmed in game — P1's fifth entry is `Enter`, and Enter
 * is what joins a slot on the character-select screen.
 *
 *   node scripts/bind-keys.mjs --show
 *   node scripts/bind-keys.mjs --assign P4 --from F13 --reload
 *   node scripts/bind-keys.mjs --restore --reload
 */

import { connect } from '../src/cdp/client.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SLOTS = ['up', 'down', 'left', 'right', 'attack', 'jump', 'defend', 'x1', 'x2', 'x3'];
const SEP = '\u00a9'; // ©
const BACKUP = 'build/keybinds-backup.json';

const has = (f) => process.argv.includes(`--${f}`);
const arg = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i === -1 ? d : process.argv[i + 1]; };

const cdp = await connect();

/** The storage key is obfuscated, so it is found by its value, not its name. */
const storageKey = JSON.parse(await cdp.evaluate(
  `JSON.stringify(Object.keys(localStorage).find(k => (localStorage.getItem(k)||'').startsWith('P1\u00a9')) ?? null)`));
if (!storageKey) throw new Error('no key-binding entry in localStorage');

const raw = JSON.parse(await cdp.evaluate(`JSON.stringify(localStorage.getItem(${JSON.stringify(storageKey)}))`));

function decode(str) {
  const parts = str.split(SEP);
  const out = {};
  for (let i = 0; i < parts.length; i += SLOTS.length + 1) {
    const player = parts[i];
    if (!player) continue;
    out[player] = Object.fromEntries(SLOTS.map((s, j) => [s, parts[i + 1 + j]]));
  }
  return out;
}
const encode = (cfg) => Object.entries(cfg)
  .flatMap(([p, keys]) => [p, ...SLOTS.map((s) => keys[s] ?? 'None')]).join(SEP);

const cfg = decode(raw);

if (has('restore')) {
  if (!existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP}`);
  await write(readFileSync(BACKUP, 'utf8').trim());
  console.log('restored from', BACKUP);
} else if (has('assign')) {
  const player = arg('assign');
  if (!cfg[player]) throw new Error(`no such player ${player}; have ${Object.keys(cfg).join(', ')}`);
  mkdirSync('build', { recursive: true });
  if (!existsSync(BACKUP)) { writeFileSync(BACKUP, raw); console.log('backed up original to', BACKUP); }

  const start = Number(String(arg('from', 'F13')).replace(/^F/i, ''));
  const keys = arg('keys')?.split(',') ?? Array.from({ length: 7 }, (_, i) => `F${start + i}`);
  SLOTS.slice(0, 7).forEach((s, i) => { cfg[player][s] = keys[i]; });
  await write(encode(cfg));
  console.log(`${player} →`, SLOTS.slice(0, 7).map((s) => `${s}=${cfg[player][s]}`).join(' '));
}

show(decode(JSON.parse(await cdp.evaluate(`JSON.stringify(localStorage.getItem(${JSON.stringify(storageKey)}))`))));

if (has('reload')) {
  // The game reads the bindings once at start-up, so nothing takes effect until it does.
  await cdp.send('Page.reload', {});
  console.log('\nreloaded — the game is back at the title screen');
}
await cdp.close();

async function write(value) {
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(value)})`);
}
function show(c) {
  console.log(`\nstorage key ${storageKey}`);
  for (const [p, keys] of Object.entries(c)) {
    console.log(`  ${p}  ${SLOTS.slice(0, 7).map((s) => `${s}:${keys[s]}`).join('  ')}`);
  }
}
