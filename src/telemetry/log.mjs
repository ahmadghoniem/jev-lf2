/**
 * Run logging.
 *
 * The experiment is only as good as what gets written down, and the expensive
 * thing to lose is a judgement: a state that Jev saw, the answer it gave, and
 * what happened next. Those replay offline against a revised question schema,
 * which is the whole reason a $5 credit can cover real iteration.
 *
 * Two streams, because they run at different rates and get read for
 * different reasons:
 *
 *   ticks.jsonl        30 Hz   what the arena looked like — the raw record
 *   judgements.jsonl   ~2 Hz   what Jev was asked and answered
 *   notes.jsonl        rare    what the observer typed while the game was paused
 *
 * Outcomes — damage, deaths, what followed a decision — are derived from the
 * tick stream afterwards (scripts/breakdown.mjs, scripts/report-run.mjs).
 *
 * The question schema is written once per run rather than repeated on every
 * judgement row. Only the stable part of it, though: the `action` and `target`
 * options are rebuilt every tick from what is actually on the ground, so
 * hashing the whole set produced a new schema file on almost every tick. A
 * benchmark over 2000 realistic ticks (`bench/schema-ab.md`) measured 1999
 * schema files and 6.94 MB that way, against 1 file and 4.56 MB when the
 * varying criteria ride along on the judgement row instead.
 */

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function openRun({ dir = 'runs', id = stamp(), meta = {} } = {}) {
  const runDir = join(dir, id);
  mkdirSync(runDir, { recursive: true });

  const streams = {
    ticks: createWriteStream(join(runDir, 'ticks.jsonl'), { flags: 'a' }),
    judgements: createWriteStream(join(runDir, 'judgements.jsonl'), { flags: 'a' }),
    notes: createWriteStream(join(runDir, 'notes.jsonl'), { flags: 'a' }),
  };
  const write = (stream, row) => streams[stream].write(`${JSON.stringify(row)}\n`);

  const started = Date.now();
  const schemas = new Map();
  const counts = { ticks: 0, judgements: 0, jevAnswers: 0, jevMisses: 0, notes: 0 };

  /**
   * Registers a question set and returns the id to reference it by.
   *
   * `dynamic` names the questions whose `criteria` is rebuilt every tick. Those
   * criteria are blanked before hashing, so the schema id stays put for a whole
   * run and the live options are stored per judgement instead.
   */
  function useSchema(questions, { dynamic = DYNAMIC_QUESTIONS } = {}) {
    const stable = Object.fromEntries(Object.entries(questions).map(
      ([qid, q]) => [qid, dynamic.has(qid) ? { ...q, criteria: PER_TICK } : q]));
    const id = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 12);
    if (!schemas.has(id)) {
      schemas.set(id, stable);
      writeFileSync(join(runDir, `schema-${id}.json`), JSON.stringify(stable, null, 2));
    }
    return id;
  }

  return {
    id,
    dir: runDir,
    useSchema,

    /** One row per executor tick. Keep it flat and small; this is the high-rate stream. */
    tick(row) {
      counts.ticks++;
      write('ticks', { t: Date.now() - started, ...row });
    },

    /**
     * One row per Jev call, including the calls that never came back — a miss
     * is data. `state` is stored verbatim because replay needs the exact input.
     */
    judgement({ tick, schema, criteria, state, answers, latencyMs, usage, requestId, source, action, error }) {
      counts.judgements++;
      if (answers) counts.jevAnswers++; else counts.jevMisses++;
      write('judgements', {
        t: Date.now() - started, tick, schema, criteria, state, answers,
        latencyMs, usage, requestId, source, action,
        error: error ? String(error.message ?? error) : undefined,
      });
    },

    /**
     * A note typed during a pause, pinned to the tick the pause began on, so
     * `scripts/notes.mjs` can show what was happening around it.
     */
    note({ tick, text }) {
      counts.notes++;
      write('notes', { t: Date.now() - started, tick, text });
    },

    /** Closes the streams and writes the manifest that describes the run. */
    async close(extra = {}) {
      const manifest = {
        id,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        schemas: [...schemas.keys()],
        counts,
        ...meta,
        ...extra,
      };
      writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await Promise.all(Object.values(streams).map((s) => new Promise((r) => s.end(r))));
      return manifest;
    },
  };
}

/** Questions whose options are rebuilt from the arena on every tick. */
const DYNAMIC_QUESTIONS = new Set(['action', 'target']);
const PER_TICK = '<stored per judgement>';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
