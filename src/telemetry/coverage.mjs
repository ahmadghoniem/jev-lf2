/**
 * What the game had in play that the harness never read.
 *
 * Every tick the whole entity pool comes in, and `readArena` keeps only the
 * kinds it knows: fighters, pick-up items and enemy energy. Anything else is
 * dropped without a trace, which is how Freeze's ice ball hit Dennis for days
 * with nothing in the log: type 3 was never on the list. This counts, per kind
 * of object, how often one moved in play without being read, and flags the
 * kinds that can hurt (a damaging hitbox in their data) and belong to someone
 * else. Those are blind spots; our own energy and harmless debris are listed
 * apart so the report stays short. One per run.
 */
import { framesFor } from '../lf2data/tables.mjs';
import { damagingItr } from '../lf2data/frames.mjs';
import { F } from '../state/fields.mjs';

/** Farther than this between reads and an object counts as moving. */
const MOVED = 0.5;

const harmCache = new Map();
/** Whether any frame of this object's data carries a damaging hitbox. */
function canHurt(id) {
  if (!harmCache.has(id)) {
    harmCache.set(id, Object.values(framesFor(id) ?? {}).some((f) => damagingItr(f).length > 0));
  }
  return harmCache.get(id);
}

export function createCoverage() {
  const kinds = new Map();
  const last = new Map(); // slot -> where it was, and as what
  return {
    observe(live, arena, tick) {
      if (!arena) return;
      const read = new Set([arena.me, arena.held, ...arena.threats, ...arena.allies,
        ...(arena.items ?? []), ...(arena.energy ?? [])].filter(Boolean).map((e) => e.slot));
      for (const e of live) {
        const key = `${e.type}/${e.name}`;
        const was = last.get(e.slot);
        last.set(e.slot, { key, x: e.x, y: e.y, z: e.z });
        const moved = was?.key === key && Math.hypot(e.x - was.x, e.y - was.y, e.z - was.z) > MOVED;
        // A knocked-out fighter leaves the threat list but can still slide.
        if (!moved || read.has(e.slot) || (e.type === 0 && e[F.hp] <= 0)) continue;
        let k = kinds.get(key);
        if (!k) {
          k = { type: e.type, name: e.name, id: e.id, hurts: canHurt(e.id), ticks: 0, ours: 0, firstTick: tick };
          kinds.set(key, k);
        }
        k.ticks++;
        if (e[F.team] === arena.me.team) k.ours++;
      }
    },
    /**
     * `blind`: kinds that can hurt and moved unread while not ours — each one
     * is something the reflexes and Jev could not see coming. `ignored`: the
     * rest, with the reason, to check the list is what it should be.
     */
    report() {
      const blind = [];
      const ignored = [];
      for (const k of kinds.values()) {
        const row = { type: k.type, name: k.name, id: k.id, ticks: k.ticks, firstTick: k.firstTick };
        if (k.hurts && k.ours < k.ticks) blind.push({ ...row, notOurs: k.ticks - k.ours });
        else ignored.push({ ...row, why: !k.hurts ? 'no damaging hitbox' : 'our own' });
      }
      return { blind: blind.sort((a, b) => b.ticks - a.ticks), ignored };
    },
  };
}
