/**
 * Sets up a VS match from a cold page: chosen fighter, chosen opponents, and
 * nothing left to chance.
 *
 * The menus are drawn on the canvas, so there is no DOM to read, but all of
 * their state lives on the one instance of the game's `Sh7E` class — the same
 * object px.js passes to its character-select routine (`ChAz`). Every step here
 * presses one key and then reads that object back, so a dropped or doubled
 * press is corrected on the next read instead of silently picking the wrong
 * fighter. Blind key counts are what made the old `--drive` fail: the fighter
 * cursor starts on Random and the pre-fight panel opens on "Reset Random".
 *
 * The page is reloaded first, which puts every screen in a known state. Key
 * bindings live in `localStorage` and survive the reload.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { classPrototype } from '../state/entities.mjs';

/** `Sh7E` fields, named. Read from px.js (`We0h`, `ChAz`). */
const READ = `function () {
  const s = this[0];
  if (!s) return null;
  const box = (i) => ({ join: s.join?.[i], fighter: s.Oh?.[i], name: s.Je?.[i]?.e0?.name, group: s.Je?.[i]?.group });
  return JSON.stringify({
    screen: s.J0,        // 10 title and mode menu, 1-3 character select, 0 in a match
    ready: Array.isArray(s.join),
    mode: s.Zs,          // mode-menu cursor; 0 is VS Mode
    phase: s.ha,         // 0 joining, 1 "how many computers", 2 picking computers, 3 pre-fight panel
    boxes: Array.from({ length: 8 }, (_, i) => box(i)),
    countdown: s.Ca,     // 45 until every joined player has locked in, then counts down
    computers: s.za,     // computer-count cursor
    picking: s.Wa?.[s.Pa], // the box of the computer being picked
    panel: s.Ga,         // 0 Fight, 1 Reset All, 2 Reset Random, 3 Background, 4 Difficulty, 5 Exit
    difficulty: s.Ie,    // 2 Easy, 1 Normal, 0 Difficult, -1 Crazy
  });
}`;

/** `join` values per box. */
const JOIN = { open: 0, fighter: 1, team: 2, locked: 3, cpuFighter: 11, cpuTeam: 12, cpuLocked: 13 };
const PANEL = { fight: 0 };
export const DIFFICULTY = { easy: 2, normal: 1, difficult: 0, crazy: -1 };

export async function menuState(cdp) {
  const proto = await classPrototype(cdp, 'Sh7E');
  const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto });
  const r = await cdp.send('Runtime.callFunctionOn', {
    objectId: q.result.objects.objectId, returnByValue: true, functionDeclaration: READ,
  });
  const v = r.result?.result?.value;
  return v ? JSON.parse(v) : null;
}

/** The stage's width in game units (`Sh7E.ph`, set from the background's `w`). */
export async function stageWidth(cdp) {
  try {
    const proto = await classPrototype(cdp, 'Sh7E');
    const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto });
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: q.result.objects.objectId,
      returnByValue: true, functionDeclaration: 'function () { return this[0]?.ph ?? null; }' });
    const w = r.result?.result?.value;
    return Number.isFinite(w) && w > 0 ? w : Infinity;
  } catch {
    return Infinity;
  }
}

const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

/**
 * @param keys  the harness slot's bindings (`readBindings`)
 * @param me    our fighter's name, e.g. 'Henry'
 * @param foes  computer opponents' names, e.g. ['Rudolf']
 */
export async function setupMatch(cdp, { keys, me, foes, difficulty = 'normal', log = () => {} }) {
  const press = (code) => cdp.key(code, { holdMs: 90 });
  let state;
  const read = async () => (state = await menuState(cdp));

  /** Presses `code` until `done(state)` holds; every press is followed by a read. */
  async function until(what, done, code, { tries = 40, gapMs = 150 } = {}) {
    for (let i = 0; i < tries; i++) {
      await read();
      if (state && done(state)) return state;
      if (code) await press(code);
      await sleep(gapMs);
    }
    throw new Error(`menu setup stuck at: ${what} (state ${JSON.stringify(state)})`);
  }

  log('reload');
  await cdp.send('Page.reload', {});
  await sleep(3000);
  await until('page load', (s) => s.screen === 10, null, { tries: 60, gapMs: 500 });

  log('title -> mode menu -> VS Mode');
  await until('mode menu', (s) => s.ready, keys.attack, { gapMs: 800 });
  await until('VS Mode highlighted', (s) => s.mode === 0, keys.up);
  await until('character select', (s) => s.screen === 1 && s.phase === 0, keys.attack, { gapMs: 800 });

  log(`join and pick ${me}`);
  const before = state.boxes.map((b) => b.join);
  await until('join', (s) => s.boxes.some((b, i) => b.join === JOIN.fighter && before[i] === JOIN.open), keys.attack);
  const mine = state.boxes.findIndex((b, i) => b.join === JOIN.fighter && before[i] === JOIN.open);
  await until(`fighter ${me}`, (s) => s.boxes[mine].fighter >= 0 && same(s.boxes[mine].name, me), keys.right);
  await until('lock fighter', (s) => s.boxes[mine].join === JOIN.team, keys.attack);
  await until('lock team', (s) => s.boxes[mine].join === JOIN.locked, keys.attack);

  log('wait out the join countdown');
  await until('computer-count prompt', (s) => s.phase === 1, null, { tries: 120, gapMs: 250 });

  log(`${foes.length} computer player(s)`);
  const step = foes.length > state.computers ? keys.right : keys.left;
  await until(`${foes.length} computers`, (s) => s.computers === foes.length, step);
  await until('computer picking', (s) => s.phase === 2 || s.phase === 3, keys.attack);

  for (const foe of foes) {
    const box = state.picking;
    log(`computer: ${foe}`);
    await until(`computer ${foe}`, (s) => s.boxes[box].fighter >= 0 && same(s.boxes[box].name, foe), keys.right);
    await until('lock computer fighter', (s) => s.boxes[box].join === JOIN.cpuTeam, keys.attack);
    await until('lock computer team', (s) => s.boxes[box].join === JOIN.cpuLocked, keys.attack);
  }

  await until('pre-fight panel', (s) => s.phase === 3, null);
  const want = DIFFICULTY[difficulty];
  if (want === undefined) throw new Error(`unknown difficulty ${difficulty}`);
  if (state.difficulty !== want) {
    await until('difficulty row', (s) => s.panel === 4, keys.down);
    await until(`difficulty ${difficulty}`, (s) => s.difficulty === want, keys.left);
  }
  log('Fight!');
  await until('Fight highlighted', (s) => s.panel === PANEL.fight, keys.up);
  await until('match start', (s) => s.screen === 0, keys.attack, { gapMs: 600 });
  return state;
}
