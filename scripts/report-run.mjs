/**
 * Offline run analysis and comparison.
 *
 * Closes the harness iteration loop: parses high-rate ticks and sparse
 * judgements to explain why a policy succeeded or failed, and compares
 * candidate runs against baseline heuristics. Reports metrics unavailable
 * from the game's summary screen (whiff rates, confidence vs outcome,
 * option coverage, and latency distributions).
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REACH_SLACK } from '../src/lf2data/frames.mjs';
import { profiles } from '../src/lf2data/tables.mjs';
import { isAttackOption } from '../src/executor/actions.mjs';
import { readJsonl } from '../src/cli.mjs';


/**
 * Loads and extracts telemetry metrics from recorded run files.
 *
 * Runs write high-frequency tick records and lower-frequency judgements
 * asynchronously. This function parses the recorded streams and computes
 * the 8 core performance signals needed to judge policy quality.
 *
 * @param {string} runDir - Path to the run directory
 * @returns {object} Calculated metrics for the run
 */
export function analyzeRun(runDir) {
  const fullDir = resolve(process.cwd(), runDir);

  // --- Load manifest
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(join(fullDir, 'manifest.json'), 'utf8')); } catch { /* none */ }

  const charName = manifest.character ?? 'Deep';
  const profile = profiles[charName.toLowerCase()] ?? null;
  const meleeReach = profile?.meleeReach ?? 50;
  const basicReach = profile?.basicAttack?.reach ?? (profile?.basicAttack?.kind === 'ranged' ? Infinity : 30);

  const effectiveMeleeReach = meleeReach + REACH_SLACK;
  const effectiveBasicReach = (basicReach === Infinity || basicReach === null)
    ? Infinity
    : basicReach + REACH_SLACK;

  const ticks = readJsonl(join(fullDir, 'ticks.jsonl'));
  const judgements = readJsonl(join(fullDir, 'judgements.jsonl'));

  // --- 1. Survival
  const totalTicks = ticks.length;
  let deadTicks = 0;
  const liveTicks = [];
  let firstDeadTick = null;

  for (const t of ticks) {
    if (t.dead || !t.me) {
      deadTicks++;
      if (!firstDeadTick && t.dead) firstDeadTick = t;
    } else {
      liveTicks.push(t);
    }
  }

  const liveTicksCount = liveTicks.length;
  const timeOfDeath = firstDeadTick
    ? `${(firstDeadTick.t / 1000).toFixed(1)}s (tick ${firstDeadTick.tick})`
    : 'none (survived)';
  const endingHp = firstDeadTick
    ? 0
    : (liveTicks.length ? liveTicks[liveTicks.length - 1].me.hp : 0);

  // --- 2. Damage taken
  let totalDmgTaken = 0;
  let defendDmgTaken = 0;
  let prevHp = null;

  for (const t of liveTicks) {
    if (prevHp !== null && t.me.hp < prevHp) {
      const drop = prevHp - t.me.hp;
      totalDmgTaken += drop;
      if (t.action === 'defend') {
        defendDmgTaken += drop;
      }
    }
    prevHp = t.me.hp;
  }

  const nonDefendDmgTaken = totalDmgTaken - defendDmgTaken;
  const defendDmgPct = totalDmgTaken > 0 ? (defendDmgTaken / totalDmgTaken) * 100 : 0;

  // --- 3. Damage dealt (upper bound)
  const threatLastHp = new Map();
  const slotDamage = new Map();
  const slotNames = new Map();

  for (const t of liveTicks) {
    for (const thr of t.threats ?? []) {
      slotNames.set(thr.slot, thr.name);
      if (threatLastHp.has(thr.slot)) {
        const prev = threatLastHp.get(thr.slot);
        if (thr.hp < prev) {
          const fall = prev - thr.hp;
          slotDamage.set(thr.slot, (slotDamage.get(thr.slot) || 0) + fall);
        }
      }
      threatLastHp.set(thr.slot, thr.hp);
    }
  }

  let totalDmgDealt = 0;
  const slotDealt = [];
  for (const [slot, name] of slotNames.entries()) {
    const dmg = slotDamage.get(slot) || 0;
    totalDmgDealt += dmg;
    slotDealt.push({ slot, name, dmg });
  }
  slotDealt.sort((a, b) => a.slot - b.slot);

  // --- 4. Action mix
  const sourceCounts = { jev: 0, heuristic: 0, reflex: 0, idle: 0 };
  const actionCounts = new Map();

  for (const t of liveTicks) {
    const src = t.source ?? 'idle';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    const act = t.action ?? 'wait';
    actionCounts.set(act, (actionCounts.get(act) || 0) + 1);
  }

  const sortedActions = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topActions = sortedActions.slice(0, 10).map(([action, count]) => ({
    action,
    count,
    pct: liveTicksCount > 0 ? (count / liveTicksCount) * 100 : 0,
  }));

  // --- 5. Decision latency & Usage
  const latencies = judgements
    .map((j) => j.latencyMs)
    .filter((l) => typeof l === 'number')
    .sort((a, b) => a - b);

  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.50)] : null;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : null;
  const maxLatency = latencies.length ? latencies[latencies.length - 1] : null;

  const totalJudgements = judgements.length;
  const missedJudgements = judgements.filter((j) => !j.answers).length;

  const isHeuristicRun = manifest.policy === 'heuristic'
    || (totalJudgements > 0 && latencies.length === 0 && judgements.every((j) => j.source === 'heuristic'));

  const missRate = isHeuristicRun
    ? null
    : (totalJudgements > 0 ? (missedJudgements / totalJudgements) * 100 : null);

  const inputTokenCounts = judgements
    .map((j) => j.usage?.input_tokens)
    .filter((t) => typeof t === 'number');
  const meanInputTokens = inputTokenCounts.length
    ? inputTokenCounts.reduce((a, b) => a + b, 0) / inputTokenCounts.length
    : null;

  // --- 6. Whiff rate
  let attacksStarted = 0;
  let attacksWhiffed = 0;
  let prevAction = null;

  for (const t of liveTicks) {
    const act = t.action;
    const isActAttack = isAttack(act);
    const wasPrevAttack = isAttack(prevAction);

    if (isActAttack && !wasPrevAttack) {
      attacksStarted++;
      const isBasic = (act === 'punch' || act === 'shoot' || act === profile?.basicAttack?.name);
      const reach = isBasic ? effectiveBasicReach : effectiveMeleeReach;

      let nearestDist = Infinity;
      for (const thr of t.threats ?? []) {
        const dist = Math.hypot(thr.dx, thr.dz);
        if (dist < nearestDist) nearestDist = dist;
      }

      if (nearestDist > reach) {
        attacksWhiffed++;
      }
    }
    prevAction = act;
  }

  const whiffRate = attacksStarted > 0 ? (attacksWhiffed / attacksStarted) * 100 : 0;

  // --- 7. Time in reach
  let insideReachCount = 0;
  let outsideReachCount = 0;

  for (const t of liveTicks) {
    let nearestDist = Infinity;
    for (const thr of t.threats ?? []) {
      const dist = Math.hypot(thr.dx, thr.dz);
      if (dist < nearestDist) nearestDist = dist;
    }
    if (nearestDist <= effectiveMeleeReach) {
      insideReachCount++;
    } else {
      outsideReachCount++;
    }
  }

  const insideReachPct = liveTicksCount > 0 ? (insideReachCount / liveTicksCount) * 100 : 0;
  const outsideReachPct = liveTicksCount > 0 ? (outsideReachCount / liveTicksCount) * 100 : 0;

  // --- 8. Confidence against outcome
  const tickHpMap = new Map();
  for (const t of ticks) {
    tickHpMap.set(t.tick, (t.dead || !t.me) ? 0 : t.me.hp);
  }

  const confBuckets = {
    low: [],
    medium: [],
    high: [],
  };

  for (const j of judgements) {
    const conf = j.answers?.action?.confidence;
    if (typeof conf !== 'number') continue;
    const startTick = j.tick;
    const startHp = tickHpMap.get(startTick);
    if (startHp === undefined) continue;
    const endHp = tickHpMap.has(startTick + 30) ? tickHpMap.get(startTick + 30) : 0;
    const delta = endHp - startHp;

    if (conf < 0.3) confBuckets.low.push(delta);
    else if (conf < 0.5) confBuckets.medium.push(delta);
    else confBuckets.high.push(delta);
  }

  const meanDelta = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const confidenceOutcome = {
    low: { count: confBuckets.low.length, meanHpDelta: meanDelta(confBuckets.low) },
    medium: { count: confBuckets.medium.length, meanHpDelta: meanDelta(confBuckets.medium) },
    high: { count: confBuckets.high.length, meanHpDelta: meanDelta(confBuckets.high) },
  };

  // --- 9. Options offered
  let totalOptionsOffered = 0;
  const allOfferedOptions = new Set();
  const allChosenOptions = new Set();

  for (const j of judgements) {
    const opts = Object.keys(j.criteria?.action || {});
    totalOptionsOffered += opts.length;
    for (const opt of opts) allOfferedOptions.add(opt);

    const chosen = j.action ?? j.answers?.action?.choice;
    if (chosen) allChosenOptions.add(chosen);
  }

  const avgOptionsOffered = totalJudgements > 0
    ? totalOptionsOffered / totalJudgements
    : null;
  const neverChosenOptions = [...allOfferedOptions]
    .filter((o) => !allChosenOptions.has(o))
    .sort();

  return {
    runDir,
    manifest,
    policy: manifest.policy ?? (isHeuristicRun ? 'heuristic' : 'unknown'),
    character: charName,
    archetype: manifest.archetype ?? profile?.archetype ?? 'melee',
    effectiveMeleeReach,
    survival: {
      totalTicks,
      liveTicks: liveTicksCount,
      deadTicks,
      livePct: totalTicks > 0 ? (liveTicksCount / totalTicks) * 100 : 0,
      deadPct: totalTicks > 0 ? (deadTicks / totalTicks) * 100 : 0,
      timeOfDeath,
      deathSec: firstDeadTick ? firstDeadTick.t / 1000 : null,
      endingHp,
    },
    damageTaken: {
      total: totalDmgTaken,
      defending: defendDmgTaken,
      defendingPct: defendDmgPct,
      nonDefending: nonDefendDmgTaken,
      nonDefendingPct: totalDmgTaken > 0 ? (nonDefendDmgTaken / totalDmgTaken) * 100 : 0,
    },
    damageDealt: {
      total: totalDmgDealt,
      slots: slotDealt,
    },
    actionMix: {
      sources: sourceCounts,
      topActions,
      liveTicksCount,
    },
    latency: {
      isHeuristicRun,
      p50,
      p95,
      max: maxLatency,
      totalJudgements,
      misses: missedJudgements,
      missRate,
      meanInputTokens,
    },
    whiff: {
      attacksStarted,
      attacksWhiffed,
      whiffRate,
    },
    timeInReach: {
      insideCount: insideReachCount,
      insidePct: insideReachPct,
      outsideCount: outsideReachCount,
      outsidePct: outsideReachPct,
    },
    confidenceOutcome,
    optionsOffered: {
      avgOffered: avgOptionsOffered,
      totalDistinctOffered: allOfferedOptions.size,
      totalChosen: allChosenOptions.size,
      neverChosen: neverChosenOptions,
    },
  };
}

/**
 * Checks whether an action string represents an offensive move.
 *
 * Excludes movement, defensive stances, drops, and item interactions.
 *
 * @param {string|null|undefined} action - Action name
 * @returns {boolean} True if action is an attack
 */
function isAttack(action) {
  return !!action && isAttackOption(action);
}

/**
 * Renders a full text report for a single recorded match.
 *
 * Emits clean, aligned text without escape codes or unicode box characters
 * for terminal reading or piping to plain files.
 *
 * @param {object} m - Analyzed run data
 * @returns {string} Formatted report text
 */
export function formatSingleRun(m) {
  const lines = [];
  const add = (str = '') => lines.push(str);

  add(`Run: ${m.runDir}`);
  add(`Policy: ${m.policy} | Character: ${m.character} (${m.archetype})`);
  add('----------------------------------------------------------------------');

  // Survival
  add('Survival');
  add(`  Ticks alive:                          ${m.survival.liveTicks} / ${m.survival.totalTicks} (${m.survival.livePct.toFixed(1)}%)`);
  add(`  Ticks dead:                           ${m.survival.deadTicks} / ${m.survival.totalTicks} (${m.survival.deadPct.toFixed(1)}%)`);
  add(`  Time of death:                        ${m.survival.timeOfDeath}`);
  add(`  HP at end:                            ${m.survival.endingHp}`);
  add();

  // Damage taken
  add('Damage Taken');
  add(`  Total HP lost:                        ${m.damageTaken.total}`);
  add(`  While defending:                      ${m.damageTaken.defending} (${m.damageTaken.defendingPct.toFixed(1)}%)`);
  add(`  While not defending:                  ${m.damageTaken.nonDefending} (${m.damageTaken.nonDefendingPct.toFixed(1)}%)`);
  add();

  // Damage dealt
  add('Damage Dealt (upper bound)*');
  add(`  Total damage dealt:                   ${m.damageDealt.total}`);
  for (const s of m.damageDealt.slots) {
    add(`  Slot ${s.slot} (${s.name}):`.padEnd(40) + `${s.dmg}`);
  }
  add('  *Note: Upper bound; with multiple fighters, hits from other COMs may be counted.');
  add();

  // Action mix
  add('Action Mix');
  add('  Live ticks by source:');
  for (const [src, count] of Object.entries(m.actionMix.sources)) {
    const pct = m.actionMix.liveTicksCount > 0
      ? (count / m.actionMix.liveTicksCount) * 100
      : 0;
    add(`    ${src}:`.padEnd(40) + `${count} (${pct.toFixed(1)}%)`);
  }
  add('  Most common actions:');
  for (const a of m.actionMix.topActions) {
    add(`    ${a.action}:`.padEnd(40) + `${a.count} (${a.pct.toFixed(1)}%)`);
  }
  add();

  // Decision latency & usage
  add('Decision Latency & Usage');
  if (m.latency.isHeuristicRun) {
    add('  Latency p50:                          not available (heuristic policy)');
    add('  Latency p95:                          not available (heuristic policy)');
    add('  Latency max:                          not available (heuristic policy)');
    add('  Miss rate:                            not available (heuristic policy)');
    add('  Mean input tokens:                    not available (heuristic policy)');
  } else {
    add(`  Latency p50:                          ${m.latency.p50 !== null ? `${m.latency.p50} ms` : 'not available'}`);
    add(`  Latency p95:                          ${m.latency.p95 !== null ? `${m.latency.p95} ms` : 'not available'}`);
    add(`  Latency max:                          ${m.latency.max !== null ? `${m.latency.max} ms` : 'not available'}`);
    add(`  Miss rate:                            ${m.latency.missRate !== null ? `${m.latency.missRate.toFixed(1)}% (${m.latency.misses}/${m.latency.totalJudgements})` : 'not available'}`);
    add(`  Mean input tokens:                    ${m.latency.meanInputTokens !== null ? m.latency.meanInputTokens.toFixed(1) : 'not available'}`);
  }
  add();

  // Whiff rate
  add('Whiff Rate');
  add(`  Attacks started:                      ${m.whiff.attacksStarted}`);
  add(`  Attacks whiffed (out of reach):       ${m.whiff.attacksWhiffed} (${m.whiff.whiffRate.toFixed(1)}%)`);
  add();

  // Time in reach
  add('Time in Reach');
  add(`  Inside reach (<= ${m.effectiveMeleeReach}):                 ${m.timeInReach.insideCount} (${m.timeInReach.insidePct.toFixed(1)}%)`);
  add(`  Outside reach (> ${m.effectiveMeleeReach}):                 ${m.timeInReach.outsideCount} (${m.timeInReach.outsidePct.toFixed(1)}%)`);
  add();

  // Confidence vs outcome
  add('Confidence Against Outcome (mean HP change over 30 ticks)');
  if (m.confidenceOutcome.low.count === 0 && m.confidenceOutcome.medium.count === 0 && m.confidenceOutcome.high.count === 0) {
    add('  Not available (no confidence scores recorded)');
  } else {
    const fmtBucket = (b) => (b.meanHpDelta !== null ? `${b.meanHpDelta >= 0 ? '+' : ''}${b.meanHpDelta.toFixed(2)} (${b.count} decisions)` : `none (0 decisions)`);
    add(`  Low (<0.3):                           ${fmtBucket(m.confidenceOutcome.low)}`);
    add(`  Medium (<0.5):                        ${fmtBucket(m.confidenceOutcome.medium)}`);
    add(`  High (>=0.5):                         ${fmtBucket(m.confidenceOutcome.high)}`);
  }
  add();

  // Options offered
  add('Options Offered');
  add(`  Mean options per decision:            ${m.optionsOffered.avgOffered !== null ? m.optionsOffered.avgOffered.toFixed(2) : 'not available'}`);
  add(`  Offered but never chosen:             ${m.optionsOffered.neverChosen.length} of ${m.optionsOffered.totalDistinctOffered} offered`);
  if (m.optionsOffered.neverChosen.length > 0) {
    const wrapped = wrapList(m.optionsOffered.neverChosen, 4, 75);
    for (const line of wrapped) add(line);
  }
  add('----------------------------------------------------------------------');

  return lines.join('\n');
}

/**
 * Renders a side-by-side comparative table with deltas for two runs.
 *
 * Compares a candidate run against a baseline across all 8 metrics, placing
 * metric name, Run A, Run B, and Delta (B - A) in aligned text columns.
 *
 * @param {object} a - Analysis of Run A (baseline)
 * @param {object} b - Analysis of Run B (candidate)
 * @returns {string} Formatted four-column comparison table
 */
export function formatComparison(a, b) {
  const lines = [];
  const add = (str = '') => lines.push(str);

  const row = (name, valA, valB, delta = '-') => {
    const c1 = String(name).padEnd(38);
    const c2 = String(valA).padEnd(22);
    const c3 = String(valB).padEnd(22);
    const c4 = String(delta);
    return `${c1}${c2}${c3}${c4}`.trimEnd();
  };

  const numDelta = (valA, valB, unit = '', decimals = 0) => {
    if (typeof valA !== 'number' || typeof valB !== 'number') return '-';
    const diff = valB - valA;
    const sign = diff > 0 ? '+' : '';
    const formatted = decimals > 0 ? diff.toFixed(decimals) : String(Math.round(diff));
    return `${sign}${formatted}${unit}`;
  };

  const pctDelta = (pctA, pctB) => {
    if (typeof pctA !== 'number' || typeof pctB !== 'number') return '-';
    const diff = pctB - pctA;
    const sign = diff > 0 ? '+' : '';
    return `${sign}${diff.toFixed(1)}%`;
  };

  add(row('Metric', `Run A (${a.policy})`, `Run B (${b.policy})`, 'Delta (B - A)'));
  add('-'.repeat(100));

  // Meta
  add(row('Run ID', a.manifest.id ?? a.runDir, b.manifest.id ?? b.runDir, '-'));
  add(row('Policy', a.policy, b.policy, '-'));
  add(row('Character', `${a.character} (${a.archetype})`, `${b.character} (${b.archetype})`, '-'));
  add();

  // Survival
  const deathDelta = (a.survival.deathSec !== null && b.survival.deathSec !== null)
    ? numDelta(a.survival.deathSec, b.survival.deathSec, 's', 1)
    : '-';

  add('Survival');
  add(row(
    '  Ticks alive',
    `${a.survival.liveTicks} (${a.survival.livePct.toFixed(1)}%)`,
    `${b.survival.liveTicks} (${b.survival.livePct.toFixed(1)}%)`,
    `${numDelta(a.survival.liveTicks, b.survival.liveTicks)} (${pctDelta(a.survival.livePct, b.survival.livePct)})`
  ));
  add(row(
    '  Ticks dead',
    `${a.survival.deadTicks} (${a.survival.deadPct.toFixed(1)}%)`,
    `${b.survival.deadTicks} (${b.survival.deadPct.toFixed(1)}%)`,
    `${numDelta(a.survival.deadTicks, b.survival.deadTicks)} (${pctDelta(a.survival.deadPct, b.survival.deadPct)})`
  ));
  add(row(
    '  Total ticks',
    a.survival.totalTicks,
    b.survival.totalTicks,
    numDelta(a.survival.totalTicks, b.survival.totalTicks)
  ));
  add(row('  Time of death', a.survival.timeOfDeath, b.survival.timeOfDeath, deathDelta));
  add(row('  HP at end', a.survival.endingHp, b.survival.endingHp, numDelta(a.survival.endingHp, b.survival.endingHp)));
  add();

  // Damage taken
  add('Damage Taken');
  add(row('  Total HP lost', a.damageTaken.total, b.damageTaken.total, numDelta(a.damageTaken.total, b.damageTaken.total)));
  add(row(
    '  While defending',
    `${a.damageTaken.defending} (${a.damageTaken.defendingPct.toFixed(1)}%)`,
    `${b.damageTaken.defending} (${b.damageTaken.defendingPct.toFixed(1)}%)`,
    `${numDelta(a.damageTaken.defending, b.damageTaken.defending)} (${pctDelta(a.damageTaken.defendingPct, b.damageTaken.defendingPct)})`
  ));
  add(row(
    '  While not defending',
    `${a.damageTaken.nonDefending} (${a.damageTaken.nonDefendingPct.toFixed(1)}%)`,
    `${b.damageTaken.nonDefending} (${b.damageTaken.nonDefendingPct.toFixed(1)}%)`,
    `${numDelta(a.damageTaken.nonDefending, b.damageTaken.nonDefending)} (${pctDelta(a.damageTaken.nonDefendingPct, b.damageTaken.nonDefendingPct)})`
  ));
  add();

  // Damage dealt
  add('Damage Dealt (upper bound)*');
  add(row('  Total damage dealt', a.damageDealt.total, b.damageDealt.total, numDelta(a.damageDealt.total, b.damageDealt.total)));

  const allSlots = new Map();
  for (const s of a.damageDealt.slots) allSlots.set(s.slot, s.name);
  for (const s of b.damageDealt.slots) allSlots.set(s.slot, s.name);

  for (const [slot, name] of [...allSlots.entries()].sort((x, y) => x[0] - y[0])) {
    const dmgA = a.damageDealt.slots.find((s) => s.slot === slot)?.dmg ?? 0;
    const dmgB = b.damageDealt.slots.find((s) => s.slot === slot)?.dmg ?? 0;
    add(row(`  Slot ${slot} (${name})`, dmgA, dmgB, numDelta(dmgA, dmgB)));
  }
  add('  *Note: Over-credits with multiple fighters; hits from other COMs may be counted.');
  add();

  // Action mix - source share
  add('Action Mix (source share)');
  const allSources = new Set([
    ...Object.keys(a.actionMix.sources),
    ...Object.keys(b.actionMix.sources),
  ]);
  for (const src of ['jev', 'heuristic', 'reflex', 'idle', ...allSources]) {
    if (!allSources.has(src)) continue;
    allSources.delete(src);
    const cntA = a.actionMix.sources[src] || 0;
    const cntB = b.actionMix.sources[src] || 0;
    const pctA = a.actionMix.liveTicksCount > 0 ? (cntA / a.actionMix.liveTicksCount) * 100 : 0;
    const pctB = b.actionMix.liveTicksCount > 0 ? (cntB / b.actionMix.liveTicksCount) * 100 : 0;
    add(row(`  ${src}`, `${pctA.toFixed(1)}% (${cntA})`, `${pctB.toFixed(1)}% (${cntB})`, pctDelta(pctA, pctB)));
  }
  add();

  // Action mix - top actions
  add('Action Mix (top actions by frequency)');
  const unionActions = new Set([
    ...a.actionMix.topActions.slice(0, 7).map((x) => x.action),
    ...b.actionMix.topActions.slice(0, 7).map((x) => x.action),
  ]);
  for (const act of unionActions) {
    const itemA = a.actionMix.topActions.find((x) => x.action === act);
    const itemB = b.actionMix.topActions.find((x) => x.action === act);
    const strA = itemA ? `${itemA.pct.toFixed(1)}% (${itemA.count})` : '0.0% (0)';
    const strB = itemB ? `${itemB.pct.toFixed(1)}% (${itemB.count})` : '0.0% (0)';
    const delta = pctDelta(itemA?.pct ?? 0, itemB?.pct ?? 0);
    add(row(`  ${act}`, strA, strB, delta));
  }
  add();

  // Decision latency & usage
  add('Decision Latency & Usage');
  const fmtLat = (lat) => (lat !== null ? `${lat} ms` : 'not available');
  add(row('  Latency p50', fmtLat(a.latency.p50), fmtLat(b.latency.p50), (a.latency.p50 && b.latency.p50) ? numDelta(a.latency.p50, b.latency.p50, ' ms') : '-'));
  add(row('  Latency p95', fmtLat(a.latency.p95), fmtLat(b.latency.p95), (a.latency.p95 && b.latency.p95) ? numDelta(a.latency.p95, b.latency.p95, ' ms') : '-'));
  add(row('  Latency max', fmtLat(a.latency.max), fmtLat(b.latency.max), (a.latency.max && b.latency.max) ? numDelta(a.latency.max, b.latency.max, ' ms') : '-'));

  const fmtMiss = (lat) => {
    if (lat.isHeuristicRun) return 'not available*';
    if (lat.missRate === null) return 'not available';
    return `${lat.missRate.toFixed(1)}% (${lat.misses}/${lat.totalJudgements})`;
  };
  add(row('  Miss rate', fmtMiss(a.latency), fmtMiss(b.latency), (a.latency.missRate !== null && b.latency.missRate !== null) ? pctDelta(a.latency.missRate, b.latency.missRate) : '-'));

  const fmtTok = (tok) => (tok !== null ? tok.toFixed(1) : 'not available');
  add(row('  Mean input tokens', fmtTok(a.latency.meanInputTokens), fmtTok(b.latency.meanInputTokens), (a.latency.meanInputTokens && b.latency.meanInputTokens) ? numDelta(a.latency.meanInputTokens, b.latency.meanInputTokens, '', 1) : '-'));
  if (a.latency.isHeuristicRun || b.latency.isHeuristicRun) {
    add('  *Note: Heuristic runs do not call an LLM; latency and tokens are not available.');
  }
  add();

  // Whiff rate
  add('Whiff Rate');
  add(row('  Attacks started', a.whiff.attacksStarted, b.whiff.attacksStarted, numDelta(a.whiff.attacksStarted, b.whiff.attacksStarted)));
  add(row(
    '  Attacks whiffed',
    `${a.whiff.attacksWhiffed} (${a.whiff.whiffRate.toFixed(1)}%)`,
    `${b.whiff.attacksWhiffed} (${b.whiff.whiffRate.toFixed(1)}%)`,
    `${numDelta(a.whiff.attacksWhiffed, b.whiff.attacksWhiffed)} (${pctDelta(a.whiff.whiffRate, b.whiff.whiffRate)})`
  ));
  add();

  // Time in reach
  add('Time in Reach');
  add(row(
    `  Inside reach (<= ${a.effectiveMeleeReach})`,
    `${a.timeInReach.insidePct.toFixed(1)}% (${a.timeInReach.insideCount})`,
    `${b.timeInReach.insidePct.toFixed(1)}% (${b.timeInReach.insideCount})`,
    `${pctDelta(a.timeInReach.insidePct, b.timeInReach.insidePct)} (${numDelta(a.timeInReach.insideCount, b.timeInReach.insideCount)})`
  ));
  add(row(
    `  Outside reach (> ${a.effectiveMeleeReach})`,
    `${a.timeInReach.outsidePct.toFixed(1)}% (${a.timeInReach.outsideCount})`,
    `${b.timeInReach.outsidePct.toFixed(1)}% (${b.timeInReach.outsideCount})`,
    `${pctDelta(a.timeInReach.outsidePct, b.timeInReach.outsidePct)} (${numDelta(a.timeInReach.outsideCount, b.timeInReach.outsideCount)})`
  ));
  add();

  // Confidence vs outcome
  add('Confidence Against Outcome (mean HP delta / +30 ticks)');
  const fmtBucket = (bkt) => (bkt.meanHpDelta !== null ? `${bkt.meanHpDelta >= 0 ? '+' : ''}${bkt.meanHpDelta.toFixed(2)} (${bkt.count} dec)` : 'not available');
  add(row('  Low (<0.3)', fmtBucket(a.confidenceOutcome.low), fmtBucket(b.confidenceOutcome.low), '-'));
  add(row('  Medium (<0.5)', fmtBucket(a.confidenceOutcome.medium), fmtBucket(b.confidenceOutcome.medium), '-'));
  add(row('  High (>=0.5)', fmtBucket(a.confidenceOutcome.high), fmtBucket(b.confidenceOutcome.high), '-'));
  add();

  // Options offered
  add('Options Offered');
  const fmtAvgOpts = (opts) => (opts.avgOffered !== null ? opts.avgOffered.toFixed(2) : 'not available');
  add(row(
    '  Mean options offered',
    fmtAvgOpts(a.optionsOffered),
    fmtAvgOpts(b.optionsOffered),
    (a.optionsOffered.avgOffered && b.optionsOffered.avgOffered) ? numDelta(a.optionsOffered.avgOffered, b.optionsOffered.avgOffered, '', 2) : '-'
  ));
  add(row(
    '  Never chosen count',
    `${a.optionsOffered.neverChosen.length} of ${a.optionsOffered.totalDistinctOffered}`,
    `${b.optionsOffered.neverChosen.length} of ${b.optionsOffered.totalDistinctOffered}`,
    numDelta(a.optionsOffered.neverChosen.length, b.optionsOffered.neverChosen.length)
  ));
  add('  Never chosen options:');
  add(`    Run A (${a.optionsOffered.neverChosen.length}):`);
  for (const line of wrapList(a.optionsOffered.neverChosen, 6, 95)) add(line);
  add(`    Run B (${b.optionsOffered.neverChosen.length}):`);
  for (const line of wrapList(b.optionsOffered.neverChosen, 6, 95)) add(line);
  add('-'.repeat(100));

  return lines.join('\n');
}

/**
 * Wraps a list of strings into indented lines fitting within a max width.
 *
 * @param {string[]} items - Items to join and wrap
 * @param {number} indent - Leading space indentation
 * @param {number} maxWidth - Target line width before wrapping
 * @returns {string[]} Formatted wrapped lines
 */
function wrapList(items, indent = 2, maxWidth = 80) {
  if (!items.length) return [' '.repeat(indent) + 'none'];
  const prefix = ' '.repeat(indent);
  const lines = [];
  let current = prefix;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = (i === items.length - 1);
    const piece = item + (isLast ? '' : ', ');

    if (current.length + piece.length > maxWidth && current.trim().length > 0) {
      lines.push(current.trimEnd());
      current = prefix + piece;
    } else {
      current += piece;
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines;
}

// --- CLI entrypoint
// Guarded so the module can be imported for `analyzeRun` (as scratch tools do)
// without printing a report as a side effect.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!isMain) {
  // imported, not run
} else if (args.length === 1) {
  const analysis = analyzeRun(args[0]);
  console.log(formatSingleRun(analysis));
} else if (args.length >= 2) {
  const analysisA = analyzeRun(args[0]);
  const analysisB = analyzeRun(args[1]);
  console.log(formatComparison(analysisA, analysisB));
} else {
  console.log('Usage: node scripts/report-run.mjs <runDir> [<runDirB>]');
}
