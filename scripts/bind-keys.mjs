/**
 * Reads and rewrites the game's key bindings.
 *
 * The remaster keeps them in `localStorage` as one delimited string, which is
 * better than the rebinding screen for our purposes: the harness can give its
 * player slot keys without the settings UI getting a say in whether those keys
 * are allowed.
 *
 * The format and its reader live in src/executor/keyboard.mjs, which the
 * harness also uses at start-up (`readBindings`), so it follows whatever is set
 * here. There is no second copy of the key map to keep in sync.
 *
 *   node scripts/bind-keys.mjs --show
 *   node scripts/bind-keys.mjs --assign P4 --from F13 --reload
 *   node scripts/bind-keys.mjs --restore --reload
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect } from '../src/cdp/client.mjs';
import { bindingStore, decodeBindings, encodeBindings, BINDING_SLOTS } from '../src/executor/keyboard.mjs';
import { arg, has } from '../src/cli.mjs';

const KEY_SLOTS = BINDING_SLOTS.slice(0, 7);
const BACKUP = 'build/keybinds-backup.json';

const cdp = await connect();
const store = await bindingStore(cdp);
const raw = await store.read();
const cfg = decodeBindings(raw);

if (has('restore')) {
  if (!existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP}`);
  await store.write(readFileSync(BACKUP, 'utf8').trim());
  console.log('restored from', BACKUP);
} else if (has('assign')) {
  const player = arg('assign');
  if (!cfg[player]) throw new Error(`no such player ${player}; have ${Object.keys(cfg).join(', ')}`);
  mkdirSync('build', { recursive: true });
  if (!existsSync(BACKUP)) { writeFileSync(BACKUP, raw); console.log('backed up original to', BACKUP); }

  const start = Number(String(arg('from', 'F13')).replace(/^F/i, ''));
  const keys = arg('keys')?.split(',') ?? Array.from({ length: 7 }, (_, i) => `F${start + i}`);
  KEY_SLOTS.forEach((s, i) => { cfg[player][s] = keys[i]; });
  await store.write(encodeBindings(cfg));
  console.log(`${player} →`, KEY_SLOTS.map((s) => `${s}=${cfg[player][s]}`).join(' '));
}

console.log(`\nstorage key ${store.storageKey}`);
for (const [p, keys] of Object.entries(decodeBindings(await store.read()))) {
  console.log(`  ${p}  ${KEY_SLOTS.map((s) => `${s}:${keys[s]}`).join('  ')}`);
}

if (has('reload')) {
  // The game reads the bindings once at start-up, so nothing takes effect until it does.
  await cdp.send('Page.reload', {});
  console.log('\nreloaded — the game is back at the title screen');
}
await cdp.close();
