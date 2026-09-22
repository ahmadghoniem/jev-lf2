/**
 * Proves the special-move input sequences actually fire.
 *
 * Every special in Little Fighter is Defend followed by a direction and a
 * button — `hit_Fa` is Defend, Forward, Attack — and the engine reads that as
 * discrete presses inside a timing window. A window guessed wrong looks exactly
 * like a move that does not exist, so this fires each one and checks the
 * fighter's frame id against the move's own entry frame rather than trusting
 * that the keys went somewhere.
 *
 *   node scripts/prove-specials.mjs                       # every special it can afford
 *   node scripts/prove-specials.mjs --press 60 --gap 90   # try a different window
 *   node scripts/prove-specials.mjs --sweep               # search for one that works
 *
 * Needs a match running with the harness's fighter alive.
 */

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { readArena } from '../src/state/arena.mjs';
import { profileFor, framesFor } from '../src/lf2data/tables.mjs';
import { keyboard, P4_KEYS } from '../src/executor/keyboard.mjs';
import { arg, has } from '../src/cli.mjs';

const SEQUENCE = {
  a: ['attack'], j: ['jump'], d: ['defend'],
  Fa: ['forward', 'attack'], Ua: ['up', 'attack'], Da: ['down', 'attack'], Uj: ['up', 'jump'],
};

const cdp = await connect();
const pool = await openEntityPool(cdp);
const kb = keyboard(cdp, P4_KEYS);

const me2 = async () => readArena(await pool.read(), {})?.me;

const arena0 = readArena(await pool.read(), {});
if (!arena0) throw new Error('no harness-controlled fighter in play — start a match first');
const profile = profileFor(arena0.me.name);
const frames = framesFor(arena0.me.id);
console.log(`${arena0.me.name}, slot ${arena0.me.slot}, mp ${arena0.me.mp}\n`);

const specials = profile.moves.filter((m) => SEQUENCE[m.input] && m.input !== 'a' && m.input !== 'j');
if (specials.length === 0) { console.log('this character has no specials in hit_*'); await done(0); }

const windows = has('sweep')
  ? [[50, 70], [60, 90], [70, 120], [90, 150], [120, 200]]
  : [[Number(arg('press', 60)), Number(arg('gap', 90))]];

const results = [];
for (const [press, gap] of windows) {
  for (const move of specials) {
    const me = await ready();
    if (!me) { results.push({ press, gap, move, ok: false, note: 'never became actionable' }); continue; }
    if (me.mp < move.mp) { results.push({ press, gap, move, ok: false, note: `needs ${move.mp} mp, had ${me.mp}` }); continue; }

    const mpBefore = me.mp;
    const seen = new Set();
    const sampling = sample(seen, 1100);
    await fire(move.input, press, gap);
    await sampling;

    // Either the entry frame itself or one of the few frames it chains into.
    const chain = chainFrom(move.entry, 8);
    const hit = [...seen].find((f) => chain.has(f));
    const after = (await me2())?.mp ?? mpBefore;
    results.push({ press, gap, move, ok: Boolean(hit),
      note: hit ? `frame ${hit}, mp ${mpBefore}→${after}` : `frames ${[...seen].join(',')}` });
    await kb.releaseAll();
    await sleep(600);
  }
}

console.log('  press  gap   move             input   result   detail');
for (const r of results) {
  console.log(`  ${String(r.press).padStart(5)}  ${String(r.gap).padStart(3)}   `
    + `${String(r.move.name ?? r.move.entry).padEnd(16)} ${r.move.input.padEnd(7)} `
    + `${r.ok ? 'FIRED ' : 'no    '}   ${r.note}`);
}
const best = results.filter((r) => r.ok);
console.log(best.length
  ? `\n${best.length}/${results.length} fired. Working windows: `
    + [...new Set(best.map((r) => `${r.press}/${r.gap}`))].join(', ')
  : '\nNothing fired. Either the window is wrong or the fighter was never free to act.');

await done(best.length ? 0 : 1);

/** The frames a move can be in shortly after it starts. */
function chainFrom(entry, depth) {
  const out = new Set();
  let id = entry;
  for (let i = 0; i < depth; i++) {
    const f = frames?.[id];
    if (!f) break;
    out.add(id);
    if (typeof f.next !== 'number' || f.next <= 0 || f.next === id) break;
    id = f.next;
  }
  return out;
}

async function fire(input, press, gap) {
  const me = await me2();
  const facing = me?.facing === 'left' ? 'left' : 'right';
  for (const step of ['defend', ...SEQUENCE[input]]) {
    // Marked intended, or the keyboard's special guard would defuse it.
    await kb.tap(step === 'forward' ? P4_KEYS[facing] : P4_KEYS[step], press, { intended: true });
    await sleep(gap);
  }
}

async function sample(into, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const me = await me2();
    if (me) into.add(me.frame);
  }
}

/** A fighter that is reeling or on the floor ignores input. */
async function ready(timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const me = await me2();
    if (me && me.frame <= 15 && me.alive) return me;
  }
  return null;
}

async function done(code) {
  await kb.releaseAll();
  await cdp.close();
  process.exit(code);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
