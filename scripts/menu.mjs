/**
 * Puts the game into a fresh match, from wherever it happens to be.
 *
 *   node scripts/menu.mjs            # land on a fresh match, or confirm one
 *   node scripts/menu.mjs --drive    # also allow the title -> VS -> join drive
 *
 * Idempotent by design: if our fighter is already at full health facing a
 * full-health opponent, nothing is pressed and it exits 0. Otherwise it presses
 * attack, which is enough on the end-of-match summary and on the pre-fight
 * panel — every setting persists across matches, so fighter, computer count,
 * background and difficulty all carry over.
 *
 * `--drive` covers the one screen the panel cannot: a game that has just
 * started and is sitting on the title screen. It is opt-in because a blind
 * `Enter` on character select would join P1, and a second human breaks
 * `readArena`'s "first human is ours" rule. Only use it from the title.
 *
 * Confirmation is always the entity pool, never a screen scrape.
 */

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { startMatch, living } from '../src/executor/match.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fighterLine = (f) => `${f.name} ${f.hp}/${f.hpMax}${f.human ? ' (human)' : ''}`;

/** Our fighter at full health and a full-health opponent: a match worth running. */
async function fresh(pool) {
  const alive = await living(pool);
  const me = alive.find((f) => f.human);
  if (!me || me.hp !== me.hpMax) return null;
  const foe = alive.find((f) => f !== me && f.hp === f.hpMax);
  return foe ? [me, foe] : null;
}

/** Our fighter alive but not full, with an opponent alive: a round under way. */
async function inProgress(pool) {
  const alive = await living(pool);
  const me = alive.find((f) => f.human);
  if (!me) return null;
  const foe = alive.find((f) => f !== me);
  return foe ? [me, foe] : null;
}

/**
 * Title -> VS Mode -> character select -> join -> attack to the panel. Blind
 * `Enter` is the risk here, so this only runs under `--drive`.
 */
async function driveFromTitle(cdp) {
  console.log('drive: title -> VS Mode');
  await cdp.key('Enter', { holdMs: 150 });
  await sleep(2500); // title -> loading -> character select
  console.log('drive: join the harness slot');
  await cdp.key('KeyK', { holdMs: 150 });
  await sleep(1200);
  console.log('drive: step fighter -> team -> computer count');
  await cdp.key('KeyK', { holdMs: 150 });
  await sleep(400);
  await cdp.key('KeyK', { holdMs: 150 });
  await sleep(400);
}

const cdp = await connect();
const pool = await openEntityPool(cdp);

const already = await fresh(pool);
if (already) {
  console.log(`fresh match already running: ${already.map((f) => f.name).join(' vs ')}`);
  process.exit(0);
}

const running = await inProgress(pool);
if (running && !process.argv.includes('--force')) {
  console.error(`a round is already under way: ${running.map(fighterLine).join(', ')}`);
  console.error('  refusing to spend attack presses on a live fight; pass --force to start over');
  process.exit(2);
}

let started = await startMatch(cdp, pool);
if (!started && process.argv.includes('--drive')) {
  await driveFromTitle(cdp);
  started = await startMatch(cdp, pool, { tries: 16 });
}

if (!started) {
  const seen = (await living(pool)).map(fighterLine);
  console.error('could not reach a fresh match');
  if (seen.length) console.error(`  fighters in pool: ${seen.join(', ')}`);
  console.error('  from the title screen, re-run with --drive');
  process.exit(1);
}

console.log(`fresh match: ${started.map((f) => f.name).join(', ')}`);
process.exit(0);
