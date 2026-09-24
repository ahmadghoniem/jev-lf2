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
/** Long enough for the game to read a press in an earlier frame than the next one. */
const FRAME_MS = 50;

/**
 * The game's special-move reader, as px.js writes it (`sg`, `hg` and their
 * siblings). A Defend press arms it; the next press, if it is a direction or
 * Jump, advances it; an Attack or Jump after that fires the special. Any other
 * press in between resets it, and nothing else does: there is no timeout, so a
 * Defend from a block two seconds ago is still armed (measured: Defend, 2 s,
 * Forward, Attack fired Henry's blastpush).
 *
 * The harness presses Defend constantly (every block) and then a direction (a
 * turn, a dodge step) and then Attack or Jump, which is exactly that sequence.
 * The runs paid for it: 150-350 MP at a time spent on specials nobody chose,
 * one of them Henry's 350-MP flute in the middle of a dodge.
 */
export function comboReader() {
  // Starts armed: whatever pressed keys before the harness took over (the input
  // check ends on Defend) is unknown, and the first run with the guard fired a
  // blastpush off exactly that press.
  let stage = 1;
  let via = null;
  let last = null; // the previous press, for two landing in one frame
  return {
    /** Whether pressing `slot` now would fire a special. */
    completes: (slot) => stage === 2
      && (slot === 'attack' || (slot === 'jump' && via !== 'jump')),
    via: () => via,
    press(slot, at = Date.now()) {
      const sameFrame = last && at - last.at < FRAME_MS;
      const before = last;
      last = { slot, at };
      if (slot === 'defend') {
        // A direction read in the same frame as Defend advances the reader
        // too: the game arms and advances in one pass.
        if (sameFrame && before.slot !== 'attack' && before.slot !== 'defend') { stage = 2; via = before.slot; }
        else { stage = 1; via = null; }
        return;
      }
      if (stage === 1 && slot !== 'attack') { stage = 2; via = slot; return; }
      // Two directions landing in the frame that advanced the reader do not
      // reset it: the game advances and then only resets on a press newer
      // than that frame. Walking diagonally after a block fired one this way.
      if (stage === 2 && sameFrame && slot !== 'attack' && slot !== 'jump') return;
      stage = 0; via = null;
    },
  };
}

/**
 * The game's team commands (px.js, the `P3` key history of a human fighter):
 * the last four presses Defend-Defend-Defend-Defend shout "Stay",
 * Defend-Attack-Defend-Attack "Move" and Defend-Jump-Defend-Jump "Come here".
 * Repeated blocks and block-then-attack produced them in play, where they are
 * noise. Returns whether pressing Defend now is the third or fourth press of
 * one, given the presses before it.
 */
export function startsShout(history) {
  const [a, b, c] = [history.at(-3), history.at(-2), history.at(-1)];
  return (b === 'defend' && (c === 'attack' || c === 'jump'))
    || (a === 'defend' && b === 'defend' && c === 'defend');
}

export function keyboard(cdp, bindings = P4_KEYS) {
  const allowed = new Set(Object.values(bindings));
  const slotOf = new Map(Object.entries(bindings).map(([slot, code]) => [code, slot]));
  const down = new Set();
  const releasing = new Map(); // code -> timer, for taps in flight
  const combo = comboReader();
  const releasedAt = new Map(); // code -> when it last went up
  let dispatched = 0;
  let defused = 0;
  let unshouted = 0;
  let facing = null;
  const history = []; // the last presses the game counted, as slots

  /** Breaks a team-command pattern with one depth tap before the Defend. */
  async function unshout() {
    const slot = ['up', 'down'].find((s) => bindings[s] && !down.has(bindings[s]));
    if (!slot) return;
    unshouted++;
    await press(bindings[slot], { intended: true });
    await sleep(FRAME_MS);
    await release(bindings[slot]);
    await sleep(FRAME_MS);
  }

  /**
   * Resets an armed special reader with one press of a direction it is not
   * waiting for, a frame ahead of the press that would have fired it.
   *
   * A depth key first, then the way the fighter faces: a tap the other way
   * turns it. Pressing left against a reader armed on Down turned Henry away
   * from Rudolf, and the arrow that followed flew the wrong way.
   */
  async function defuse() {
    const ahead = facing === 'left' ? ['left', 'right'] : ['right', 'left'];
    const slot = ['up', 'down', ...ahead]
      .find((s) => s !== combo.via() && bindings[s] && !down.has(bindings[s]));
    if (!slot) return;
    defused++;
    await press(bindings[slot], { intended: true });
    await sleep(FRAME_MS);
    await release(bindings[slot]);
  }

  async function press(code, { intended = false } = {}) {
    if (!allowed.has(code) || down.has(code)) return;
    const slot = slotOf.get(code);
    if (!intended && combo.completes(slot)) await defuse();
    if (slot === 'defend' && startsShout(history)) await unshout();
    // A key let go and pressed again inside one frame never looks up to the
    // game, so it is no new press and does not reset the reader. Counted as
    // one, it hid an armed Defend-Forward: a special cut off by a new answer
    // left the stance holding Forward, and the next arrow fired a 150-MP
    // blastpush.
    if (!(Date.now() - (releasedAt.get(code) ?? -Infinity) < FRAME_MS)) {
      combo.press(slot);
      history.push(slot);
      if (history.length > 4) history.shift();
    }
    down.add(code); dispatched++;
    await cdp.keyEvent('keyDown', code);
  }

  async function release(code) {
    if (!down.has(code)) return;
    releasedAt.set(code, Date.now());
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

    /**
     * A momentary press, released on its own. Ignored while one is in flight.
     * `intended` marks a press that is part of a special on purpose.
     */
    async tap(code, ms = TAP_MS, { intended = false } = {}) {
      if (releasing.has(code)) return;
      await press(code, { intended });
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

    /** Which way the fighter faces, read each tick, so a defuse does not turn it. */
    set facing(dir) { facing = dir; },

    get stats() { return { dispatched, defused, unshouted, down: [...down] }; },
  };
}

