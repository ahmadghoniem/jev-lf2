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

import { readArena, doing, createLiveness, createHeldTracker, createItemMotion } from '../state/arena.mjs';
import { profileFor } from '../lf2data/tables.mjs';
import { planAction, ROLL_START_TICKS } from './actions.mjs';
import { createReflex } from './reflex.mjs';
import { offer } from './policies.mjs';
import { bucketRange } from '../lf2data/profile.mjs';

/**
 * An answer about a fight this old is about a different fight. Measured in
 * milliseconds rather than ticks because the loop does not always hit its
 * target rate — a run that paces at 22 Hz would otherwise get a 1.4-second
 * staleness window while believing it had one second.
 */
const STALE_MS = 1500;

// A single frame can read hp as 0/undefined while the entity is mid-transition
// (spawn, certain hit states), which used to log a false death at t≈0. A fighter
// only counts as dead once it has read not-alive for this many ticks in a row.
const DEAD_CONFIRM_TICKS = 15;
/**
 * How long a decided match keeps running before the loop stops. Past this the
 * run only logs a corpse or an empty stage and pays for Jev calls about
 * nothing: two of three recent runs spent over half their decisions after the
 * enemy was dead.
 */
const DECIDED_TICKS = 90;

export async function runLoop({ cdp, pool, kb, run, name, policy, overlay, hz = 30,
                               decideEveryMs = 500, seconds = 120, onTick, keys,
                               staleMs = STALE_MS } = {}) {
  const period = 1000 / hz;
  let until = Date.now() + seconds * 1000;

  let tick = 0;
  let action = 'wait';
  let source = 'idle';
  let stance = null;
  let burst = null;
  let pending = null;
  let planned = null;      // the cached plan for the current action
  let plannedFor = null;   // which action it was planned for
  let lastAsk = 0;
  let recent = {};
  let shown = { policy: policy.name };   // what the overlay is currently saying
  let forceDraw = false;                 // set when an answer lands, cleared once drawn
  let deadStreak = 0;                    // consecutive not-alive reads (debounce)
  let confirmedDead = false;             // once true, every later tick logs as dead
  let noEnemyStreak = 0;
  const counts = { ticks: 0, decisions: 0, misses: 0, reflexes: 0, stale: 0, bursts: 0, dead: 0,
                   defused: 0, outcome: 'time' };

  // One tracker for the whole run, so fighters left over from an earlier match
  // drop out of the threat list about a second in.
  const isLive = createLiveness();
  // And one for the weapon in hand, which is confirmed by motion rather than by
  // the fighter merely standing next to something on the ground.
  const heldTracker = createHeldTracker();
  // And one for weapons in flight, which is the only way a thrown weapon is
  // told apart from one lying on the ground.
  const motionTracker = createItemMotion();
  // And the reflex layer's own state, so its block is a finite parry with a rest
  // between rather than a guard held until it breaks.
  const reflexFor = createReflex();

  const profile = profileFor(name);
  if (!profile) throw new Error(`no derived profile for ${name} — rebuild build/_profiles.json`);

  // The game paused (Esc) is a person looking at the fight. Nothing is asked
  // or pressed until it resumes, the paused time is added back to the run, and
  // anything typed into the pause box is logged against the tick the pause
  // began on.
  let paused = false;
  let pausedAtMs = 0;
  const fromPage = (res) => {
    if (!res) return;
    for (const n of res.notes ?? []) run?.note({ tick, text: n.text });
    paused = !!res.paused;
  };

  while (Date.now() < until) {
    if (paused) {
      if (!pausedAtMs) {
        pausedAtMs = Date.now();
        pending = null;   // its answer would describe the fight before the pause
        await kb.releaseAll();
      }
      fromPage(await overlay?.update({ ...shown, paused: true }, { force: true }));
      if (!paused) {
        until += Date.now() - pausedAtMs;
        pausedAtMs = 0;
        lastAsk = 0;      // ask about the resumed fight at once
        await kb.releaseAll();
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
      continue;
    }

    const t0 = performance.now();
    const arena = readArena(await pool.read(), { name, isLive, heldTracker, motionTracker });
    tick++; counts.ticks++;

    if (!arena) { await kb.releaseAll(); await pace(t0, period); continue; }

    if (!arena.me.alive) {
      deadStreak++;
      await kb.releaseAll();
      if (deadStreak >= DEAD_CONFIRM_TICKS || confirmedDead) {
        confirmedDead = true;
        counts.dead++;
        if (counts.dead >= DECIDED_TICKS) { counts.outcome = 'lost'; break; }
        run?.tick({ tick, dead: true });
        fromPage(await overlay?.update({ ...shown, dead: true, action, source, counts,
          hp: arena.me.hp, hpMax: arena.me.hpMax, mp: arena.me.mp, darkHp: arena.me.darkHp }));
      }
      await pace(t0, period);
      continue;
    }
    deadStreak = 0;
    noEnemyStreak = arena.threats.length ? 0 : noEnemyStreak + 1;
    if (noEnemyStreak >= DECIDED_TICKS) { counts.outcome = 'won'; break; }

    // --- the layer that cannot wait for a network call
    const reflex = reflexFor(arena);
    if (reflex) {
      counts.reflexes++;
      action = reflex.action; source = 'reflex'; stance = null;
      plannedFor = null;   // a reflex tick is a new order; re-plan it
    }

    // --- a decision that arrived since the last tick
    if (pending?.settled) {
      const { result, askedAt, askedAtMs } = pending;
      pending = null;
      if (Date.now() - askedAtMs > staleMs) counts.stale++;
      // A thrown weapon is already in the air and the block answers it, so that
      // one reflex holds against a late answer; everything else steps aside.
      // The roll is the exception: nothing hits it either, so it may replace the
      // block when the weapon is far enough off for the roll to start first.
      // Without this, a roll chosen against Rudolf's stars — most of the times
      // it is offered — was always overruled by the block.
      else if (result?.action && (!reflex?.thrown
               || (result.action === 'roll_away' && reflex.eta >= ROLL_START_TICKS))) {
        action = result.action; source = policy.name; stance = null;
        plannedFor = null;   // each answer owns one execution, not one ever
        recent = { last_action: action, outcome: 'pending' };
      } else if (!result?.action) counts.misses++;
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
      // The question set is built once and both hashed and sent, so the schema
      // on record is the one the policy actually asked.
      const questions = policy.questions(options, arena);
      const schema = run?.useSchema(questions);
      const askedAt = tick;
      const record = { settled: false, askedAt, askedAtMs: Date.now(), result: null };
      pending = record;
      counts.decisions++;
      policy.decide({ arena, options, questions, recent }).then((result) => {
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
    // The plan is cached while the action is unchanged. Re-planning every tick
    // recreated each stance from scratch, which silently reset any state it
    // kept — the aimed attack's sequence counter never got past its first
    // press, so the special was tapped into nothing and the fighter stood
    // there. The stance still re-reads the arena every tick; only its
    // construction is cached.
    if (!burst) {
      if (plannedFor !== action) {
        planned = planAction(action, { arena, profile, keys });
        plannedFor = action;
      }
      const plan = planned;
      if (plan?.kind === 'burst') {
        counts.bursts++;
        plannedFor = null;
        burst = plan.run(kb).finally(() => { burst = null; });
      } else if (plan?.kind === 'stance') {
        stance = plan.step;
        const step = stance(arena);
        await kb.hold(step.hold ?? []);
        for (const code of step.tap ?? []) await kb.tap(code, undefined, { intended: !!step.special });
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
        doing: t.doing, vulnerable: t.vulnerable, hp: t.hp, dx: Math.round(t.dx), dz: Math.round(t.dz),
        // The enemy's own destination, so a decision that read it can be checked
        // after the fact against where the enemy actually went.
        destDx: t.destDx === null ? null : Math.round(t.destDx),
        approach: !!t.approach })),
      // `dx`/`dz` and `inFlight` are what make a thrown weapon checkable after
      // the fact: with range alone, a weapon crossing the stage and one lying
      // beside us look the same in the log. `speed` is the measured closing
      // rate, which is what the dodge's reaction maths is built on.
      items: arena.items.slice(0, 3).map((i) => ({ slot: i.slot, name: i.name, range: Math.round(i.range),
        dx: Math.round(i.dx), dz: Math.round(i.dz), inFlight: !!i.inFlight, closing: !!i.closing,
        hostile: !!i.hostile, speed: Math.round(i.speed ?? 0) })),
      action, source,
      reflex: reflex?.reason ?? null,
      keys: kb.stats.down,
    });
    const near = arena.threats[0];
    fromPage(await overlay?.update({
      ...shown, action, source, counts, reflex: reflex?.reason ?? null,
      hp: arena.me.hp, darkHp: arena.me.darkHp, hpMax: arena.me.hpMax, mp: arena.me.mp,
      nearest: near ? { name: near.name, distance: bucketRange(near.gap), doing: near.doing, vulnerable: near.vulnerable, helpless: near.helpless } : null,
      // Shown because a thrown weapon is invisible in every other reading: the
      // enemy looks idle and the weapon looks like something to walk over.
      threat: arena.flying[0]
        ? { name: arena.flying[0].name, distance: bucketRange(arena.flying[0].range) } : null,
    }, { force: forceDraw }));
    forceDraw = false;

    onTick?.({ tick, arena, action, source });

    await pace(t0, period);
  }

  await kb.releaseAll();
  // A note typed in the last moments is still waiting in the page.
  fromPage(await overlay?.update({ ...shown, counts }, { force: true }));
  counts.defused = kb.stats.defused ?? 0;
  return counts;
}

async function pace(t0, period) {
  const left = period - (performance.now() - t0);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
