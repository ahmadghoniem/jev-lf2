/**
 * A live decision panel drawn over the game.
 *
 * The game's own interface is DOM rather than canvas, so the overlay is DOM too
 * and lands in the same layer instead of fighting the renderer. What it draws
 * is the part of a decision that a recording cannot show you while it happens:
 * which options were on the table, how close the second choice was, and whether
 * the action on screen came from Jev or from the reflex layer overruling it.
 *
 * The page-side half lives in `overlay.page.js` so its CSS and markup can be
 * edited as code. The page answers each update with two things: whether the
 * game is paused, and any notes typed into the pause box since the last one.
 */

import { readFileSync } from 'node:fs';
import { classPrototype } from '../state/entities.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'overlay.page.js'), 'utf8');

export function createOverlay(cdp, { enabled = true, minIntervalMs = 100 } = {}) {
  let installed = false;
  let last = 0;

  return {
    get enabled() { return enabled; },

    async install() {
      if (!enabled) return false;
      await cdp.evaluate(PAGE);
      // The pause flag lives on the game's one `Sh7E` instance, which nothing
      // on `window` reaches; give the page a reference so the note box can
      // follow it. Without it the panel still draws and the box never opens.
      try {
        const proto = await classPrototype(cdp, 'Sh7E');
        const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto });
        await cdp.send('Runtime.callFunctionOn', { objectId: q.result.objects.objectId,
          functionDeclaration: 'function () { window.__jevGameRef = this[0]; }' });
      } catch { /* no pause notes this run */ }
      installed = true;
      return true;
    },

    /**
     * Throttled, because the loop runs at 30 Hz and the eye does not. A new
     * decision passes `force` so it is never the update that gets dropped.
     */
    async update(data, { force = false } = {}) {
      if (!installed) return null;
      const now = Date.now();
      if (!force && now - last < minIntervalMs) return null;
      last = now;
      try {
        return await cdp.evaluate(`window.__jev && window.__jev(${JSON.stringify(data)})`) ?? null;
      } catch {
        // A reload or a scene change can take the panel with it; the next
        // install puts it back. Never let drawing break the fight.
        installed = false;
        return null;
      }
    },

    async remove() {
      if (!installed) return;
      await cdp.evaluate("document.getElementById('jev-overlay')?.remove();"
        + "document.getElementById('jev-overlay-style')?.remove(); window.__jevNoteCleanup?.();"
        + 'delete window.__jev; delete window.__jevGameRef;');
      installed = false;
    },
  };
}
