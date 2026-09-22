/**
 * Proves the harness can actually drive a fighter, not just a menu.
 *
 * Menus accept a key and move a cursor; that says nothing about whether the
 * game's input sampler sees a synthetic key during a fight, where input is read
 * per frame rather than on an event. Worse, a wrong key fails *silently*: the
 * dispatch succeeds, nothing moves, and the telemetry still reports the action
 * the policy intended. That is exactly how a whole run was spent pressing
 * `Numpad*` at a slot bound to `KeyI`/`KeyK`.
 *
 * So each check presses a key and reads the consequence out of the entity pool —
 * position for movement, height for a jump, the current frame id for an attack.
 *
 * A fighter that is lying down, reeling or being juggled by a COM ignores input,
 * so checks that never get an actionable window come back `inconclusive` rather
 * than `fail`. Only the `attack` check is treated as decisive by callers: an
 * attack animation can be produced by our key and by nothing else, while a hit
 * from the COM can fake movement, height and a frame change.
 */

import { fighters } from '../state/entities.mjs';
import { F } from '../state/fields.mjs';
import { profileFor } from '../lf2data/tables.mjs';

/** Frames 0-15 are the standing, walking and running blocks. */
const ACTIONABLE_MAX_FRAME = 15;

export async function proveInput({ cdp, pool, name, keys }) {
  const wanted = name.toLowerCase();
  const me = async () => fighters(await pool.read()).find((f) => f.name?.toLowerCase() === wanted);

  const start = await me();
  if (!start) throw new Error(`${name} is not in play — start a match with that fighter first`);

  const profile = profileFor(wanted);
  if (!profile) throw new Error(`no profile for ${wanted} — rebuild build/_profiles.json`);
  // Both kinds count: the gate asks whether our key produced an attack
  // animation, and for an archer the attack is a drawn bow, whose entry frames
  // live in the ranged moves. Melee-only cost a whole run once — Henry's arrow
  // frames were on screen, unrecognised, and the run was refused.
  const attackFrames = new Set(profile.moves
    .filter((m) => m.kind === 'melee' || m.kind === 'ranged').map((m) => m.entry));

  const delta = (s, field) => s.at(-1)[field] - s[0][field];

  const ready = async (timeoutMs = 6000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const f = await me();
      if (f && f[F.frame] <= ACTIONABLE_MAX_FRAME) return f;
    }
    return null;
  };

  /** Presses a key while sampling the pool, so the reaction is caught mid-press. */
  const check = async ({ name: label, slot, holdMs, gate = false, pass, detail }) => {
    const before = await ready();
    if (!before) {
      return { name: label, gate, status: 'inconclusive',
        detail: 'never became actionable — down the whole window' };
    }
    const samples = [];
    const sampling = (async () => {
      const until = Date.now() + holdMs + 400;
      while (Date.now() < until) {
        const f = await me();
        if (f) samples.push(f);
      }
    })();
    await cdp.key(keys[slot], { holdMs });
    await sampling;
    const s = [before, ...samples];
    return { name: label, gate, status: pass(s) ? 'pass' : 'fail', detail: detail(s) };
  };

  return [
    await check({ name: 'walk left', slot: 'left', holdMs: 600,
      pass: (s) => delta(s, 'x') < -10, detail: (s) => `x moved ${delta(s, 'x').toFixed(0)}` }),
    await check({ name: 'walk right', slot: 'right', holdMs: 600,
      pass: (s) => delta(s, 'x') > 10, detail: (s) => `x moved ${delta(s, 'x').toFixed(0)}` }),
    await check({ name: 'jump', slot: 'jump', holdMs: 250,
      pass: (s) => Math.min(...s.map((f) => f.y)) < -5,
      detail: (s) => `peak height ${Math.min(...s.map((f) => f.y)).toFixed(0)}` }),
    await check({ name: 'attack', slot: 'attack', holdMs: 400, gate: true,
      pass: (s) => s.some((f) => attackFrames.has(f[F.frame])),
      detail: (s) => `frames ${[...new Set(s.map((f) => f[F.frame]))].join(',')}` }),
    await check({ name: 'defend', slot: 'defend', holdMs: 400,
      pass: (s) => s.some((f) => f[F.frame] !== start[F.frame]),
      detail: (s) => `frames ${[...new Set(s.map((f) => f[F.frame]))].join(',')}` }),
  ];
}

export function reportProbe(results, log = console.log) {
  log('\n  check        result          detail');
  for (const r of results) {
    log(`  ${r.name.padEnd(12)} ${r.status.toUpperCase().padEnd(14)} ${r.detail}`);
  }
}
