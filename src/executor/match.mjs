/**
 * Starting the next match without a human at the keyboard.
 *
 * From the end-of-match summary one attack press lands on the pre-fight panel
 * with `Fight!` already highlighted, and every setting is kept — characters,
 * computer-player count, background, difficulty. So a restart is attack presses
 * until fighters appear in the pool, and their appearance is the confirmation.
 *
 * Once a match is over, Esc opens the menu with `Fight!` to pick, and Enter
 * starts the same fight again with every setting kept; attack presses remain
 * as the fallback. During a round Esc only pauses, so a round still being
 * fought is restarted from the pause bar: Esc, then Q ("Restart"), then Enter.
 * Reloading and walking the menus (`setupMatch`) is only for changing fighters.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fighters } from '../state/entities.mjs';
import { readFighter } from '../state/fields.mjs';
import { menuState } from './setup.mjs';

export const living = async (pool) =>
  fighters(await pool.read()).map(readFighter).filter((f) => f.alive);

/** Where the summary appears: `afterMatch` stops at this (observed 2026-09-25). */
const SUMMARY_AT = 144;

/**
 * From a decided match to the pre-fight panel with Fight! highlighted. Esc
 * reaches the panel only once the summary is up, a second or so after the
 * last fighter falls; pressed before that it pauses the fight instead, which
 * is how a restart froze the game on 2026-09-25. So this waits for the
 * summary, resumes a paused fight, and only then presses Esc.
 */
async function toFightPanel(cdp, { up = 'KeyI', waitMs = 15000 } = {}) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const s = await menuState(cdp).catch(() => null);
    if (!s) { await sleep(250); continue; }
    if (s.screen !== 0 && s.phase === 3) {
      for (let i = 0; i < 8 && s.panel !== 0; i++) {
        await cdp.key(up, { holdMs: 80 });
        await sleep(200);
        s.panel = (await menuState(cdp)).panel;
      }
      return s.panel === 0;
    }
    if (s.paused) { await cdp.key('Escape', { holdMs: 80 }); await sleep(500); continue; }
    if (s.screen === 0 && s.afterMatch >= SUMMARY_AT) { await cdp.key('Escape', { holdMs: 80 }); await sleep(800); continue; }
    await sleep(250);
  }
  return false;
}

export async function startMatch(cdp, pool, { attack = 'KeyK', tries = 12, gapMs = 1500 } = {}) {
  let restarted = false;
  let escaped = false;
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
    // The match is over: Esc to the menu, Enter on Fight!.
    if (!escaped) {
      escaped = true;
      if (await toFightPanel(cdp)) {
        await cdp.key('Enter', { holdMs: 80 });
        await sleep(gapMs);
        continue;
      }
    }
    await cdp.key(attack, { holdMs: 150 });
    await sleep(gapMs);
  }
  return null;
}
