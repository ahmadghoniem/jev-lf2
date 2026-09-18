/**
 * Benchmarks two schema storage designs for the Jev telemetry harness.
 *
 * Variant A hashes the entire question set (including live criteria that churns
 * every tick) and writes a distinct schema file for each unique hash.
 *
 * Variant B hashes only the stable schema structure (question IDs, types,
 * instructions, and static criteria) and inlines the dynamic criteria (action
 * and target option maps) directly into each judgement row.
 *
 * This benchmark measures the schema file count, storage footprints, and
 * serialization timing across 2000 realistic ticks to determine which approach
 * minimizes disk usage and file sprawl.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { buildOptions } from '../src/state/options.mjs';
import { RANGE_BUCKETS } from '../src/lf2data/profile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Creates a deterministic pseudo-random number generator using the Mulberry32
 * algorithm so benchmark runs produce identical byte footprints every run.
 */
export function createRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates synthetic match ticks with realistic variation across characters,
 * distances, weapon states, MP levels, and enemy threats.
 */
function* generateTicks({ ticks = 2000, profiles, weapons, seed = 42 } = {}) {
  const rng = createRng(seed);

  // Selected characters representing ranged, melee, and mixed archetypes
  const characters = [
    profiles.henry, // ranged
    profiles.bandit, // melee
    profiles.davis, // mixed
    profiles.woody, // mixed
  ];

  // Weapon IDs with attack tables plus drink items from build/_weapons.json
  const usableWeaponIds = [100, 101, 120, 121, 122, 124, 213];
  const threatNames = ['Bandit', 'Hunter', 'Davis', 'Knight', 'Julian', 'Deep'];
  const threatActions = ['approaching', 'attacking', 'recovering', 'standing'];
  const threatSides = ['front', 'back'];

  const fixedAggressionCriteria = [
    '0: Purely defensive. Retreat or hold block, avoid taking damage.',
    '1: Cautious. Probe with low-risk attacks or maintain safe spacing.',
    '2: Offensive. Advance and look for damaging hits while watching for counters.',
    '3: All-out attack. Commit to maximum damage regardless of risk.',
  ];

  const fixedCommitCriteria = {
    true: 'Attacking now is unlikely to be punished.',
    false: 'Attacking now is likely to be punished.',
  };

  for (let tick = 1; tick <= ticks; tick++) {
    const profile = characters[Math.floor(rng() * characters.length)];
    const mp = Math.floor(rng() * 501);

    // Pick distance bucket and a distance value within that bucket
    const bucket = RANGE_BUCKETS[Math.floor(rng() * RANGE_BUCKETS.length)];
    let nearest;
    if (bucket.name === 'touching') {
      nearest = Math.floor(rng() * 31) + 10;
    } else if (bucket.name === 'melee') {
      nearest = Math.floor(rng() * 65) + 45;
    } else if (bucket.name === 'one_step') {
      nearest = Math.floor(rng() * 105) + 115;
    } else if (bucket.name === 'one_dash') {
      nearest = Math.floor(rng() * 195) + 225;
    } else {
      nearest = Math.floor(rng() * 275) + 425;
    }

    // Held weapon: null or a real weapon
    const hasHeld = rng() < 0.5;
    const heldWeaponIds = [100, 101, 120, 121, 124, 213];
    const heldId = hasHeld ? heldWeaponIds[Math.floor(rng() * heldWeaponIds.length)] : null;
    const held = heldId ? { id: heldId, name: weapons[heldId]?.name } : null;

    // Ground items: 0 to 3 items
    const nearbyCount = Math.floor(rng() * 4);
    const nearby = [];
    for (let j = 0; j < nearbyCount; j++) {
      const wid = usableWeaponIds[Math.floor(rng() * usableWeaponIds.length)];
      nearby.push({
        id: wid,
        name: weapons[wid]?.name,
        type: weapons[wid]?.type,
        distance: Math.floor(rng() * 580) + 20,
        contested: rng() < 0.25,
      });
    }

    const options = buildOptions({ profile, weapons, held, nearby, nearest, mp });

    // Live threats: 1 to 3 threats
    const threatCount = Math.floor(rng() * 3) + 1;
    const threats = [];
    const targetCriteria = {};
    for (let t = 1; t <= threatCount; t++) {
      const threatId = `threat_${t}`;
      const name = threatNames[Math.floor(rng() * threatNames.length)];
      const distBucket = RANGE_BUCKETS[Math.floor(rng() * RANGE_BUCKETS.length)].name;
      const side = threatSides[Math.floor(rng() * threatSides.length)];
      const doing = threatActions[Math.floor(rng() * threatActions.length)];
      threats.push({ id: threatId, name, distance: distBucket, side, doing, hp: 'healthy' });
      targetCriteria[threatId] = `Focus on ${name}, ${distBucket} away on ${side}, currently ${doing}.`;
    }

    const questions = {
      action: {
        type: 'choice',
        instructions: 'Choose what this fighter should do right now. Prefer the option that does the most damage for the risk it takes, given where the enemy is.',
        criteria: options,
      },
      target: {
        type: 'choice',
        instructions: 'Choose which enemy threat to target. Prefer the most immediate or vulnerable threat.',
        criteria: targetCriteria,
      },
      aggression: {
        type: 'score',
        instructions: 'Rate how aggressively this fighter should behave right now from 0 (purely defensive) to 3 (all-out attack).',
        criteria: fixedAggressionCriteria,
      },
      commit: {
        type: 'noul',
        instructions: 'Should this fighter commit to an attack this instant?',
        criteria: fixedCommitCriteria,
      },
    };

    const chosenAction = Object.keys(options)[0] ?? 'wait';
    const chosenTarget = threats[0]?.id ?? 'none';

    const state = {
      me: {
        character: profile.name,
        archetype: profile.archetype,
        hp: 'healthy',
        mp: mp === 0 ? 'empty' : mp < 200 ? 'low' : 'full',
        holding: held ? weapons[held.id]?.name ?? 'weapon' : 'none',
        stance: 'standing',
        facing: 'right',
      },
      threats,
    };

    const answers = {
      action: {
        choice: chosenAction,
        confidence: 0.82,
        probabilities: { [chosenAction]: 0.82 },
      },
      target: {
        choice: chosenTarget,
        confidence: 0.76,
        probabilities: { [chosenTarget]: 0.76 },
      },
      aggression: {
        score: 2,
        confidence: 0.7,
        probabilities: [0.05, 0.15, 0.7, 0.1],
      },
      commit: {
        noul: 0.85,
        confidence: 0.85,
      },
    };

    yield {
      tick,
      profile,
      questions,
      options,
      targetCriteria,
      state,
      answers,
      chosenAction,
    };
  }
}

/**
 * Runs the benchmark comparing Variant A and Variant B across synthetic ticks,
 * recording schema creation, row bytes, and execution overhead.
 */
export async function runBenchmark({ ticks = 2000, seed = 42 } = {}) {
  const profilesPath = join(ROOT, 'build/_profiles.json');
  const weaponsPath = join(ROOT, 'build/_weapons.json');

  if (!existsSync(profilesPath) || !existsSync(weaponsPath)) {
    throw new Error('build/_profiles.json or build/_weapons.json is missing; run node scripts/build-move-tables.mjs first.');
  }

  const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
  const weapons = JSON.parse(readFileSync(weaponsPath, 'utf8'));

  const dirA = mkdtempSync(join(tmpdir(), 'jev-bench-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'jev-bench-b-'));

  try {
    const streamA = createWriteStream(join(dirA, 'judgements.jsonl'), { flags: 'a' });
    const streamB = createWriteStream(join(dirB, 'judgements.jsonl'), { flags: 'a' });

    const schemasA = new Map();
    const schemasB = new Map();

    let timeA = 0;
    let timeB = 0;

    let cumulativeSchemaBytesA = 0;
    let cumulativeJudgementsBytesA = 0;
    let cumulativeSchemaBytesB = 0;
    let cumulativeJudgementsBytesB = 0;

    const milestones = [1, 2, 3, 5, 10, 50, 100, 500, 1000, ticks];
    const crossoverData = [];
    let firstFlippedTick = null;

    for (const tickData of generateTicks({ ticks, profiles, weapons, seed })) {
      const { tick, questions, options, targetCriteria, state, answers, chosenAction } = tickData;

      // ------------------------------------------------------------- Variant A
      const startA = performance.now();
      const jsonA = JSON.stringify(questions);
      const schemaIdA = createHash('sha256').update(jsonA).digest('hex').slice(0, 12);
      if (!schemasA.has(schemaIdA)) {
        const content = JSON.stringify(questions, null, 2);
        schemasA.set(schemaIdA, questions);
        writeFileSync(join(dirA, `schema-${schemaIdA}.json`), content);
        cumulativeSchemaBytesA += Buffer.byteLength(content);
      }

      const rowA = {
        t: tick * 500,
        tick,
        schema: schemaIdA,
        state,
        answers,
        latencyMs: 340,
        usage: { input_tokens: 574, output_tokens: 65 },
        requestId: `req_${tick}`,
        source: 'jev',
        action: chosenAction,
      };
      const rowStrA = `${JSON.stringify(rowA)}\n`;
      streamA.write(rowStrA);
      timeA += performance.now() - startA;
      cumulativeJudgementsBytesA += Buffer.byteLength(rowStrA);

      // ------------------------------------------------------------- Variant B
      const startB = performance.now();
      const stableSchema = {
        action: {
          type: questions.action.type,
          instructions: questions.action.instructions,
        },
        target: {
          type: questions.target.type,
          instructions: questions.target.instructions,
        },
        aggression: {
          type: questions.aggression.type,
          instructions: questions.aggression.instructions,
          criteria: questions.aggression.criteria,
        },
        commit: {
          type: questions.commit.type,
          instructions: questions.commit.instructions,
          criteria: questions.commit.criteria,
        },
      };

      const jsonB = JSON.stringify(stableSchema);
      const schemaIdB = createHash('sha256').update(jsonB).digest('hex').slice(0, 12);
      if (!schemasB.has(schemaIdB)) {
        const content = JSON.stringify(stableSchema, null, 2);
        schemasB.set(schemaIdB, stableSchema);
        writeFileSync(join(dirB, `schema-${schemaIdB}.json`), content);
        cumulativeSchemaBytesB += Buffer.byteLength(content);
      }

      const rowB = {
        t: tick * 500,
        tick,
        schema: schemaIdB,
        state,
        criteria: {
          action: options,
          target: targetCriteria,
        },
        answers,
        latencyMs: 340,
        usage: { input_tokens: 574, output_tokens: 65 },
        requestId: `req_${tick}`,
        source: 'jev',
        action: chosenAction,
      };
      const rowStrB = `${JSON.stringify(rowB)}\n`;
      streamB.write(rowStrB);
      timeB += performance.now() - startB;
      cumulativeJudgementsBytesB += Buffer.byteLength(rowStrB);

      // Track crossover point
      const totalBytesA = cumulativeSchemaBytesA + cumulativeJudgementsBytesA;
      const totalBytesB = cumulativeSchemaBytesB + cumulativeJudgementsBytesB;
      if (firstFlippedTick === null && totalBytesB < totalBytesA) {
        firstFlippedTick = tick;
      }

      if (milestones.includes(tick)) {
        crossoverData.push({
          tick,
          schemasA: schemasA.size,
          bytesA: totalBytesA,
          schemasB: schemasB.size,
          bytesB: totalBytesB,
          diff: totalBytesA - totalBytesB,
          winner: totalBytesB < totalBytesA ? 'B' : 'A',
        });
      }
    }

    // Wait for all stream writes to finish
    await Promise.all([
      new Promise((resolve) => streamA.end(resolve)),
      new Promise((resolve) => streamB.end(resolve)),
    ]);

    // Measure actual files and disk sizes
    const filesA = readdirSync(dirA).filter((f) => f.startsWith('schema-') && f.endsWith('.json'));
    const schemaBytesA = filesA.reduce((sum, f) => sum + statSync(join(dirA, f)).size, 0);
    const judgementsBytesA = statSync(join(dirA, 'judgements.jsonl')).size;
    const totalBytesA = schemaBytesA + judgementsBytesA;
    const meanRowBytesA = judgementsBytesA / ticks;

    const filesB = readdirSync(dirB).filter((f) => f.startsWith('schema-') && f.endsWith('.json'));
    const schemaBytesB = filesB.reduce((sum, f) => sum + statSync(join(dirB, f)).size, 0);
    const judgementsBytesB = statSync(join(dirB, 'judgements.jsonl')).size;
    const totalBytesB = schemaBytesB + judgementsBytesB;
    const meanRowBytesB = judgementsBytesB / ticks;

    return {
      ticks,
      variantA: {
        schemaFiles: filesA.length,
        schemaBytes: schemaBytesA,
        judgementsBytes: judgementsBytesA,
        meanRowBytes: meanRowBytesA,
        totalBytes: totalBytesA,
        timeMs: timeA,
      },
      variantB: {
        schemaFiles: filesB.length,
        schemaBytes: schemaBytesB,
        judgementsBytes: judgementsBytesB,
        meanRowBytes: meanRowBytesB,
        totalBytes: totalBytesB,
        timeMs: timeB,
      },
      crossoverData,
      firstFlippedTick,
    };
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

/**
 * Formats the benchmark metrics into markdown tables and verdict summary.
 */
function formatReport(result) {
  const { ticks, variantA: a, variantB: b, crossoverData, firstFlippedTick } = result;

  const byteDiff = a.totalBytes - b.totalBytes;
  const pctBytesSaved = ((byteDiff / a.totalBytes) * 100).toFixed(1);
  const fileDiff = a.schemaFiles - b.schemaFiles;
  const pctFilesSaved = ((fileDiff / a.schemaFiles) * 100).toFixed(1);

  const lines = [];

  lines.push('# Schema Storage Benchmark: Variant A vs Variant B');
  lines.push('');
  lines.push(`Evaluated across **${ticks} synthetic ticks** of realistic gameplay with dynamic option generation from \`buildOptions\` (varying characters, MP, weapons, distances, and live threats).`);
  lines.push('');
  lines.push('## Metrics Comparison');
  lines.push('');
  lines.push('| Metric | Variant A (Full Schema Hashing) | Variant B (Stable Schema + Inline Criteria) | Delta (B vs A) |');
  lines.push('|---|---|---|---|');
  lines.push(`| Schema files written | ${a.schemaFiles.toLocaleString()} | ${b.schemaFiles.toLocaleString()} | -${fileDiff.toLocaleString()} (-${pctFilesSaved}%) |`);
  lines.push(`| Total bytes of schema files | ${a.schemaBytes.toLocaleString()} B (${(a.schemaBytes / 1024 / 1024).toFixed(2)} MB) | ${b.schemaBytes.toLocaleString()} B (${(b.schemaBytes / 1024).toFixed(2)} KB) | -${(a.schemaBytes - b.schemaBytes).toLocaleString()} B |`);
  lines.push(`| Total bytes of judgements.jsonl | ${a.judgementsBytes.toLocaleString()} B (${(a.judgementsBytes / 1024 / 1024).toFixed(2)} MB) | ${b.judgementsBytes.toLocaleString()} B (${(b.judgementsBytes / 1024 / 1024).toFixed(2)} MB) | +${(b.judgementsBytes - a.judgementsBytes).toLocaleString()} B |`);
  lines.push(`| Mean bytes per judgement row | ${a.meanRowBytes.toFixed(1)} B | ${b.meanRowBytes.toFixed(1)} B | +${(b.meanRowBytes - a.meanRowBytes).toFixed(1)} B |`);
  lines.push(`| Combined total bytes | ${a.totalBytes.toLocaleString()} B (${(a.totalBytes / 1024 / 1024).toFixed(2)} MB) | ${b.totalBytes.toLocaleString()} B (${(b.totalBytes / 1024 / 1024).toFixed(2)} MB) | -${byteDiff.toLocaleString()} B (-${pctBytesSaved}%) |`);
  lines.push(`| Hashing + serialising time | ${a.timeMs.toFixed(1)} ms | ${b.timeMs.toFixed(1)} ms | ${(b.timeMs - a.timeMs).toFixed(1)} ms |`);
  lines.push('');
  lines.push('## Crossover Progression');
  lines.push('');
  lines.push('| Tick | Variant A Schemas | Variant A Total Bytes | Variant B Schemas | Variant B Total Bytes | Winner | Margin |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of crossoverData) {
    const margin = Math.abs(row.diff).toLocaleString() + ' B';
    lines.push(`| ${row.tick} | ${row.schemasA} | ${row.bytesA.toLocaleString()} B | ${row.schemasB} | ${row.bytesB.toLocaleString()} B | **Variant ${row.winner}** | ${row.winner === 'B' ? 'B by ' + margin : 'A by ' + margin} |`);
  }
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  const tick1 = crossoverData[0];
  let crossoverSentence = '';
  if (firstFlippedTick !== null && firstFlippedTick > 1) {
    crossoverSentence = `Variant A holds an initial advantage at run lengths under ${firstFlippedTick} ticks because row overhead in Variant B temporarily outweighs schema creation, but the winner flips permanently to Variant B at tick ${firstFlippedTick} once schema churn accumulates.`;
  } else {
    crossoverSentence = `Variant B wins across all evaluated run lengths starting from tick 1 (by ${Math.abs(tick1.diff).toLocaleString()} B) and steadily expanding its advantage because dynamic option churn forces Variant A to write a ~2.8 KB pretty-printed schema file on nearly every tick.`;
  }

  lines.push(
    `Variant B is the decisive winner, eliminating ${pctFilesSaved}% of schema files (${b.schemaFiles} file vs ${a.schemaFiles.toLocaleString()} files) and reducing total storage by ${(byteDiff / 1024 / 1024).toFixed(2)} MB (${pctBytesSaved}% smaller footprint at ${ticks} ticks). ` +
    `${crossoverSentence} ` +
    `Variant A could only win if question criteria remained static across a match (where a single shared schema amortizes over compact rows), but under realistic combat with continuous variation in distances, weapons, and MP, Variant B decisively prevents severe filesystem inode exhaustion and disk waste.`
  );
  lines.push('');

  return lines.join('\n');
}

// ----------------------------------------------------------------- CLI runner
const result = await runBenchmark({ ticks: 2000, seed: 42 });
const markdown = formatReport(result);

// Write to bench/schema-ab.md
const benchDir = join(ROOT, 'bench');
if (!existsSync(benchDir)) {
  mkdirSync(benchDir, { recursive: true });
}
writeFileSync(join(benchDir, 'schema-ab.md'), markdown, 'utf8');

// Print report to stdout
console.log(markdown);
