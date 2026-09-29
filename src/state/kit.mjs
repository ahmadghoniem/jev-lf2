/**
 * What an enemy can do, from its move list, for the state Jev sees
 * (`--enemy-kit`, trial of 2026-09-30). The same builder for every fighter:
 * its up-close moves, the attacks it runs in with, its projectiles and the
 * rest, each with damage, reach, MP and whether it knocks down or breaks a
 * guard. Built once per fighter.
 */
import { profileFor } from '../lf2data/tables.mjs';

const RUN_IN = new Set(['dash_attack', 'run_attack']);
const MAX_PER_GROUP = 4;
const cache = new Map();

const named = (m) => m.name && m.name !== 'null' && !m.needsWeapon;
const words = (name) => name.replace(/[_+]+/g, ' ').trim();
const said = (m) => [
  m.damage ? `${m.damage} damage` : null,
  m.reach ? `reach ${m.reach} px` : m.range ? `range ${m.range} px` : null,
  m.mp ? `${m.mp} MP` : 'free',
  m.breaksGuard ? 'breaks guard' : null,
  m.knocksDown ? 'knocks down' : null,
].filter(Boolean).join(', ');

/** One line per move name, the strongest version of each, strongest first. */
function lines(moves) {
  const best = new Map();
  for (const m of moves) if ((best.get(m.name)?.damage ?? -1) < (m.damage ?? 0)) best.set(m.name, m);
  return [...best.values()].sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0))
    .slice(0, MAX_PER_GROUP).map((m) => `${words(m.name)}: ${said(m)}`);
}

export function kitOf(name) {
  if (cache.has(name)) return cache.get(name);
  const moves = (profileFor(name)?.moves ?? []).filter(named);
  const kit = moves.length ? {
    up_close: lines(moves.filter((m) => m.kind === 'melee' && !RUN_IN.has(m.name))),
    run_in: lines(moves.filter((m) => m.kind === 'melee' && RUN_IN.has(m.name))),
    projectiles: lines(moves.filter((m) => m.kind === 'ranged')),
    other: moves.filter((m) => m.kind === 'utility').map((m) => `${words(m.name)} (${m.mp ? `${m.mp} MP` : 'free'})`),
  } : null;
  if (kit) for (const k of Object.keys(kit)) if (!kit[k].length) delete kit[k];
  cache.set(name, kit);
  return kit;
}
