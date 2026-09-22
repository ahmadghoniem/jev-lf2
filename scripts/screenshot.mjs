/**
 * Look at the game: optionally send keys, then save a screenshot.
 *
 *   node scripts/screenshot.mjs                            # just look
 *   node scripts/screenshot.mjs --keys Enter               # press, then look
 *   node scripts/screenshot.mjs --keys F17 --wait 1500 --out runs/shot.png
 *
 * Needs the game running with the CDP port open (scripts/launch-game.mjs).
 */

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from '../src/cdp/client.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const keys = (arg('keys', '') || '').split(',').filter(Boolean);
const gap = Number(arg('gap', 350));
const wait = Number(arg('wait', 600));

const cdp = await connect();
for (const k of keys) { await cdp.key(k, { holdMs: 120 }); await sleep(gap); }
await sleep(wait);
const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (!r.result?.data) { console.log('no screenshot data', JSON.stringify(r).slice(0, 300)); }
else { const out = arg('out', 'runs/shot.png'); writeFileSync(out, Buffer.from(r.result.data, 'base64')); console.log('wrote', out, r.result.data.length, 'b64 chars'); }
await cdp.close();
