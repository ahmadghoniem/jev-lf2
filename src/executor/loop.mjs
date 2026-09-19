/**
 * The executor.
 *
 * Reads the arena at 30 Hz, decides at about 2 Hz, and never lets the second
 * rate hold up the first: a decision is asked for without awaiting it, tagged
 * with the tick it was asked at, and thrown away if it comes back describing a
 * fight that has already moved on. In between, the character keeps playing on
 * reflexes and on whatever it was last told to do.
 *
 * Every tick records which layer produced the action — `jev`, `heuristic` or
 * `reflex` — because otherwise there is no way to tell whose result it is.
 */

import { readArena, doing, createLiveness } from '../state/arena.mjs';
import { profileFor } from '../lf2data/tables.mjs';
import { planAction } from './actions.mjs';
import { reflexAction } from './reflex.mjs';
import { offer } from './policies.mjs';
import { bucketRange } from '../lf2data/profile.mjs';

/**
 * An answer about a fight this old is about a different fight. Measured in
 * milliseconds rather than ticks because the loop does not always hit its
 * target rate — a run that paces at 22 Hz would otherwise get a 1.4-second
 * staleness window while believing it had one second.
 */
const STALE_MS = 1300;

export async function runLoop({ cdp, pool, kb, run, name, policy, overlay, hz = 30,
                               decideEveryMs = 500, seconds = 120, onTick } = {}) {
  const period = 1000 / hz;
  const until = Date.now() + seconds * 1000;

  let tick = 0;
  let action = 'wait';
  let source = 'idle';
  let stance = null;
  let burst = null;
  let pending = null;
  let lastAsk = 0;
  let recent = {};
  let shown = { policy: policy.name };   // what the overlay is currently saying
  let forceDraw = false;                 // set when an answer lands, cleared once drawn
  const counts = { ticks: 0, decisions: 0, misses: 0, reflexes: 0, stale: 0, bursts: 0, dead: 0 };

  // One tracker for the whole run, so fighters left over from an earlier match
  // drop out of the threat list about a second in.
  const isLive = createLiveness();

  const profile = profileFor(name);
  if (!profile) throw new Error(`no derived profile for ${name} — rebuild build/_profiles.json`);

  while (Date.now() < until) {
    const t0 = performance.now();
    const arena = readArena(await pool.read(), { name, isLive });
    tick++; counts.ticks++;

    if (!arena) { await kb.releaseAll(); await pace(t0, period); continue; }

    if (!arena.me.alive) {
      counts.dead++;
      await kb.releaseAll();
      run?.tick({ tick, dead: true });
      await overlay?.update({ ...shown, dead: true, action, source, counts,
        hp: arena.me.hp, hpMax: arena.me.hpMax, mp: arena.me.mp, darkHp: arena.me.darkHp });
      await pace(t0, period);
      continue;
    }

    // --- the layer that cannot wait for a network call
    const reflex = reflexAction(arena);
    if (reflex) { counts.reflexes++; action = reflex.action; source = 'reflex'; stance = null; }

    // --- a decision that arrived since the last tick
    if (pending?.settled) {
      const { result, askedAt, askedAtMs } = pending;
      pending = null;
      if (Date.now() - askedAtMs > STALE_MS) counts.stale++;
      else if (result?.action) {
        action = result.action; source = policy.name; stance = null;
        recent = { last_action: action, outcome: 'pending' };
      } else counts.misses++;
      shown = {
        ...shown,
        latencyMs: result?.latencyMs ?? null,
        confidence: result?.answers?.action?.confidence ?? null,
        probabilities: result?.answers?.action?.probabilities ?? null,
        commit: result?.answers?.commit?.noul ?? null,
      };
      forceDraw = true;
    }

    // --- ask for the next one, without waiting for it
    if (!pending && !burst && Date.now() - lastAsk >= decideEveryMs) {
      lastAsk = Date.now();
      const options = offer(arena, profile);
      // The panel names the options as they are chosen, so the list on screen is
      // the list Jev was handed — not a redraw of the last answer's keys.
      shown = { ...shown, options: Object.keys(options) };
      forceDraw = true;
      // Hash the question set the policy will actually send, not a stand-in for it.
      const schema = run?.useSchema(policy.questions?.(options, arena) ?? { action: { type: 'choice', criteria: options } });
      const askedAt = tick;
      const record = { settled: false, askedAt, askedAtMs: Date.now(), result: null };
      pending = record;
      counts.decisions++;
      policy.decide({ arena, options, recent }).then((result) => {
        record.result = result; record.settled = true;
        run?.judgement({
          tick: askedAt, schema, criteria: { action: options },
          state: result?.state, answers: result?.answers, latencyMs: result?.latencyMs,
          usage: result?.usage, requestId: result?.requestId, source: policy.name,
          action: result?.action,
        });
      }).catch((error) => {
        record.settled = true;
        run?.judgement({ tick: askedAt, schema, source: policy.name, error });
      });
    }

    // --- carry out whatever is current
    if (!burst) {
      const plan = planAction(action, { arena, profile });
      if (plan?.kind === 'burst') {
        counts.bursts++;
        burst = plan.run(kb).finally(() => { burst = null; });
      } else if (plan?.kind === 'stance') {
        stance = plan.step;
        const step = stance(arena);
        await kb.hold(step.hold ?? []);
        for (const code of step.tap ?? []) await kb.tap(code);
      } else {
        await kb.hold([]);
      }
    }

    run?.tick({
      tick,
      me: { frame: arena.me.frame, doing: doing(arena.me), hp: arena.me.hp,
            darkHp: arena.me.darkHp, mp: arena.me.mp, x: arena.me.x, z: arena.me.z,
            facing: arena.me.facing, holding: arena.held?.name ?? null },
      threats: arena.threats.slice(0, 3).map((t) => ({ slot: t.slot, name: t.name, frame: t.frame,
        doing: doing(t), hp: t.hp, dx: Math.round(t.dx), dz: Math.round(t.dz) })),
      items: arena.items.slice(0, 3).map((i) => ({ slot: i.slot, name: i.name, range: Math.round(i.range) })),
      action, source,
      reflex: reflex?.reason ?? null,
      keys: kb.stats.down,
    });
    const near = arena.threats[0];
    await overlay?.update({
      ...shown, action, source, counts, reflex: reflex?.reason ?? null,
      hp: arena.me.hp, darkHp: arena.me.darkHp, hpMax: arena.me.hpMax, mp: arena.me.mp,
      nearest: near ? { name: near.name, distance: bucketRange(near.gap), doing: doing(near) } : null,
    }, { force: forceDraw });
    forceDraw = false;

    onTick?.({ tick, arena, action, source });

    await pace(t0, period);
  }

  await kb.releaseAll();
  return counts;
}

async function pace(t0, period) {
  const left = period - (performance.now() - t0);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
