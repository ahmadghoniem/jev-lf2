/**
 * Puts the game into a fresh match, from wherever it happens to be.
 *
 *   node scripts/menu.mjs            # land on a fresh match, or confirm one
 *   node scripts/menu.mjs --setup --fighter Henry --vs Rudolf [--difficulty normal]
 *                                    # reload and set up that exact match
 *
 * Idempotent by design: if our fighter is already at full health facing a
 * full-health opponent, nothing is pressed and it exits 0. Otherwise it presses
 * attack, which is enough on the end-of-match summary and on the pre-fight
 * panel — every setting persists across matches, so fighter, computer count,
 * background and difficulty all carry over.
 *
 * `--setup` is the deterministic start: it reloads the page and walks every
 * menu, reading the menu state back after each press (src/executor/setup.mjs).
 * `--vs` takes a comma-separated list for more than one computer. Use it after
 * a launch, or to change fighters; plain restarts keep the settings.
 *
 * Confirmation is always the entity pool, never a screen scrape.
 */

import { connect } from '../src/cdp/client.mjs';
import { openEntityPool } from '../src/state/entities.mjs';
import { startMatch, living } from '../src/executor/match.mjs';
import { arg, has } from '../src/cli.mjs';
import { setupMatch } from '../src/executor/setup.mjs';
import { readBindings } from '../src/executor/keyboard.mjs';

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

const cdp = await connect();

if (has('setup')) {
  const me = arg('fighter', 'Henry');
  const foes = String(arg('vs', 'Rudolf')).split(',').map((s) => s.trim()).filter(Boolean);
  await setupMatch(cdp, {
    keys: await readBindings(cdp), me, foes, difficulty: arg('difficulty', 'normal'),
    log: (m) => console.log(`setup: ${m}`),
  });
  // The reload made a new page context, so the pool is opened only now.
  const pool = await openEntityPool(cdp);
  let alive = [];
  for (let i = 0; i < 20 && alive.length < 1 + foes.length; i++) { await sleep(250); alive = await living(pool); }
  const ours = alive.find((f) => f.human);
  const theirs = alive.filter((f) => !f.human).map((f) => f.name.toLowerCase()).sort();
  const wanted = foes.map((f) => f.toLowerCase()).sort();
  if (ours?.name.toLowerCase() !== me.toLowerCase() || theirs.join() !== wanted.join()) {
    console.error(`set up the wrong match: ${alive.map(fighterLine).join(', ')}`);
    process.exit(1);
  }
  console.log(`fresh match: ${alive.map(fighterLine).join(', ')}`);
  process.exit(0);
}

const pool = await openEntityPool(cdp);

const already = await fresh(pool);
if (already) {
  console.log(`fresh match already running: ${already.map((f) => f.name).join(' vs ')}`);
  process.exit(0);
}

const running = await inProgress(pool);
if (running && !has('force')) {
  console.error(`a round is already under way: ${running.map(fighterLine).join(', ')}`);
  console.error('  refusing to spend attack presses on a live fight; pass --force to start over');
  process.exit(2);
}

const started = await startMatch(cdp, pool);

if (!started) {
  const seen = (await living(pool)).map(fighterLine);
  console.error('could not reach a fresh match');
  if (seen.length) console.error(`  fighters in pool: ${seen.join(', ')}`);
  console.error('  from the title screen, or to change fighters, re-run with --setup');
  process.exit(1);
}

console.log(`fresh match: ${started.map((f) => f.name).join(', ')}`);
process.exit(0);
