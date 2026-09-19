/**
 * Starting the next match without a human at the keyboard.
 *
 * From the end-of-match summary one attack press lands on the pre-fight panel
 * with `Fight!` already highlighted, and every setting is kept — characters,
 * computer-player count, background, difficulty. So a restart is attack presses
 * until fighters appear in the pool, and their appearance is the confirmation.
 */

import { fighters } from '../state/entities.mjs';
import { readFighter } from '../state/fields.mjs';

export const living = async (pool) =>
  fighters(await pool.read()).map(readFighter).filter((f) => f.alive);

export async function startMatch(cdp, pool, { attack = 'F17', tries = 8, gapMs = 1500 } = {}) {
  for (let i = 0; i <= tries; i++) {
    const alive = await living(pool);
    // A fresh match has everyone at full health; a finished one has corpses.
    if (alive.length >= 2 && alive.every((f) => f.hp === f.hpMax)) return alive;
    if (i === tries) break;
    await cdp.key(attack, { holdMs: 150 });
    await sleep(gapMs);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
