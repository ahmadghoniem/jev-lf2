/**
 * Key state for the harness's player slot.
 *
 * `cdp.key()` presses and releases in one await, which is right for a menu and
 * wrong for a fight: walking means holding a direction across many ticks while
 * the loop keeps reading and deciding. So this tracks what is currently down
 * and each tick is told what *should* be down, rather than being told to press.
 *
 * Only keys in `bindings` are ever dispatched, so a bug here cannot reach the
 * humans' slots.
 */

import { KEY_OF, VK_OF } from '../cdp/client.mjs';

export const P4_KEYS = {
  up: 'F13', down: 'F14', left: 'F15', right: 'F16',
  attack: 'F17', jump: 'F18', defend: 'F19',
};

/** A tap shorter than a game frame can fall between two samples. */
const TAP_MS = 100;

export function keyboard(cdp, bindings = P4_KEYS) {
  const allowed = new Set(Object.values(bindings));
  const down = new Set();
  const releasing = new Map(); // code -> timer, for taps in flight
  let dispatched = 0;

  const event = (type, code) => cdp.send('Input.dispatchKeyEvent', {
    type, code, key: KEY_OF[code] ?? code, windowsVirtualKeyCode: VK_OF[code] ?? 0,
  });

  async function press(code) {
    if (!allowed.has(code) || down.has(code)) return;
    down.add(code); dispatched++;
    await event('keyDown', code);
  }

  async function release(code) {
    if (!down.has(code)) return;
    down.delete(code); dispatched++;
    await event('keyUp', code);
  }

  return {
    /** The full set of keys that should be held right now; everything else lifts. */
    async hold(codes = []) {
      const want = new Set(codes.filter((c) => allowed.has(c)));
      const work = [];
      for (const c of down) if (!want.has(c) && !releasing.has(c)) work.push(release(c));
      for (const c of want) work.push(press(c));
      await Promise.all(work);
    },

    /** A momentary press, released on its own. Ignored while one is in flight. */
    async tap(code, ms = TAP_MS) {
      if (releasing.has(code)) return;
      await press(code);
      releasing.set(code, setTimeout(() => { releasing.delete(code); release(code); }, ms));
    },

    /** Two quick taps then a hold — how the game reads a run or a dash. */
    async doubleTap(code, gapMs = 60) {
      await press(code);
      await sleep(gapMs);
      await release(code);
      await sleep(gapMs);
      await press(code);
    },

    async releaseAll() {
      for (const t of releasing.values()) clearTimeout(t);
      releasing.clear();
      await Promise.all([...down].map(release));
    },

    get stats() { return { dispatched, down: [...down] }; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
