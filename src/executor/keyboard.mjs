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

import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Fallback only. The slot's real keys live in the game's own settings and are
 * read back with `readBindings`; a hardcoded map is what let the harness press
 * `Numpad*` against a slot bound to `KeyI`/`KeyK`, so every log line claimed an
 * attack while the fighter stood still.
 */
export const P4_KEYS = {
  up: 'KeyI', down: 'Comma', left: 'KeyJ', right: 'KeyL',
  attack: 'KeyK', jump: 'Space', defend: 'Period',
};

/**
 * Per player, the game stores ten key codes in this order; the last three are
 * unused. Confirmed in game — P1's fifth entry is `Enter`, which is what joins a
 * slot on the character-select screen.
 */
export const BINDING_SLOTS = ['up', 'down', 'left', 'right', 'attack', 'jump', 'defend', 'x1', 'x2', 'x3'];
const SEP = String.fromCharCode(0xa9); // ©

/**
 * The game's key-binding entry in `localStorage`. Its key is obfuscated, so it
 * is found by its value, which always starts with `P1©`.
 */
export async function bindingStore(cdp) {
  const storageKey = JSON.parse(await cdp.evaluate(
    `JSON.stringify(Object.keys(localStorage).find(k => (localStorage.getItem(k)||'').startsWith('P1${SEP}')) ?? null)`));
  if (!storageKey) throw new Error('no key-binding entry in localStorage');
  const at = JSON.stringify(storageKey);
  return {
    storageKey,
    read: async () => JSON.parse(await cdp.evaluate(`JSON.stringify(localStorage.getItem(${at}))`)),
    write: (value) => cdp.evaluate(`localStorage.setItem(${at}, ${JSON.stringify(value)})`),
  };
}

/** `P1©ArrowUp©…©P2©…` as `{ P1: { up: 'ArrowUp', … }, … }`, and back. */
export function decodeBindings(raw) {
  const parts = raw.split(SEP);
  const out = {};
  for (let i = 0; i < parts.length; i += BINDING_SLOTS.length + 1) {
    const player = parts[i];
    if (player) out[player] = Object.fromEntries(BINDING_SLOTS.map((s, j) => [s, parts[i + 1 + j]]));
  }
  return out;
}
export const encodeBindings = (cfg) => Object.entries(cfg)
  .flatMap(([p, keys]) => [p, ...BINDING_SLOTS.map((s) => keys[s] ?? 'None')]).join(SEP);

/**
 * The keys the game will actually listen for, read from its `localStorage`
 * binding entry rather than assumed. Assumed keys fail silently: the press is
 * dispatched, nothing moves, and the telemetry still shows the intended action.
 */
export async function readBindings(cdp, player = 'P4') {
  const keys = decodeBindings(await (await bindingStore(cdp)).read())[player];
  if (!keys) throw new Error(`no bindings for ${player}`);
  return Object.fromEntries(BINDING_SLOTS.slice(0, 7).map((s) => [s, keys[s]]));
}

/** A tap shorter than a game frame can fall between two samples. */
const TAP_MS = 100;

export function keyboard(cdp, bindings = P4_KEYS) {
  const allowed = new Set(Object.values(bindings));
  const down = new Set();
  const releasing = new Map(); // code -> timer, for taps in flight
  let dispatched = 0;

  async function press(code) {
    if (!allowed.has(code) || down.has(code)) return;
    down.add(code); dispatched++;
    await cdp.keyEvent('keyDown', code);
  }

  async function release(code) {
    if (!down.has(code)) return;
    down.delete(code); dispatched++;
    await cdp.keyEvent('keyUp', code);
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

