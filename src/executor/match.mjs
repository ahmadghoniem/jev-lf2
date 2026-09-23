/**
 * Starting the next match without a human at the keyboard.
 *
 * From the end-of-match summary one attack press lands on the pre-fight panel
 * with `Fight!` already highlighted, and every setting is kept — characters,
 * computer-player count, background, difficulty. So a restart is attack presses
 * until fighters appear in the pool, and their appearance is the confirmation.
 *
 * A round still being fought is restarted from the pause menu instead: Esc,
 * then Q (the pause bar's "Restart"), lands on the same pre-fight panel with
 * `Fight!` highlighted, and Enter starts it — about four seconds, with every
 * setting kept. Reloading and walking the menus (`setupMatch`) is only for
 * changing fighters.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fighters } from '../state/entities.mjs';
import { readFighter } from '../state/fields.mjs';

export const living = async (pool) =>
  fighters(await pool.read()).map(readFighter).filter((f) => f.alive);

export async function startMatch(cdp, pool, { attack = 'KeyK', tries = 12, gapMs = 1500 } = {}) {
  let restarted = false;
  for (let i = 0; i <= tries; i++) {
    const alive = await living(pool);
    // A fresh match has our fighter and at least one opponent at full health.
    // Checking *every* fighter instead would never pass, because the pool keeps
    // fighters from previous matches at whatever health they died on and
    // nothing clears them.
    const me = alive.find((f) => f.human);
    const ready = me && me.hp === me.hpMax
      && alive.some((f) => f !== me && f.hp === f.hpMax);
    if (ready) return alive.filter((f) => f.hp === f.hpMax);
    if (i === tries) break;
    // Both sides still standing is a round in progress, where attack presses
    // only swing at the enemy.
    if (!restarted && me && alive.some((f) => f !== me)) {
      restarted = true;
      await cdp.key('Escape', { holdMs: 80 });
      await sleep(400);
      await cdp.key('KeyQ', { holdMs: 80 });
      await sleep(800);
      await cdp.key('Enter', { holdMs: 80 });
      await sleep(gapMs);
      continue;
    }
    await cdp.key(attack, { holdMs: 150 });
    await sleep(gapMs);
  }
  return null;
}
