/**
 * Run logging.
 *
 * The experiment is only as good as what gets written down, and the expensive
 * thing to lose is a judgement: a state that Jev saw, the answer it gave, and
 * what happened next. Those replay offline against a revised question schema,
 * which is the whole reason a $5 credit can cover real iteration.
 *
 * Three streams, because they run at different rates and get read for
 * different reasons:
 *
 *   ticks.jsonl        30 Hz   what the arena looked like — the raw record
 *   judgements.jsonl   ~2 Hz   what Jev was asked, answered, and what followed
 *   events.jsonl       sparse  discrete facts: damage, pickups, deaths
 *
 * The question schema is written once per run rather than repeated on every
 * judgement row, since it is identical across a run and dwarfs the row.
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
    events: createWriteStream(join(runDir, 'events.jsonl'), { flags: 'a' }),
  };
  const write = (stream, row) => streams[stream].write(`${JSON.stringify(row)}\n`);

  const started = Date.now();
  const schemas = new Map();
  const counts = { ticks: 0, judgements: 0, events: 0, jevAnswers: 0, jevMisses: 0 };

  /**
   * Registers a question set and returns the id to reference it by. Called
   * once per schema, not once per tick.
   */
  function useSchema(questions) {
    const json = JSON.stringify(questions);
    const id = createHash('sha256').update(json).digest('hex').slice(0, 12);
    if (!schemas.has(id)) {
      schemas.set(id, questions);
      writeFileSync(join(runDir, `schema-${id}.json`), JSON.stringify(questions, null, 2));
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
    judgement({ tick, schema, state, answers, latencyMs, usage, requestId, source, action, error }) {
      counts.judgements++;
      if (answers) counts.jevAnswers++; else counts.jevMisses++;
      write('judgements', {
        t: Date.now() - started, tick, schema, state, answers,
        latencyMs, usage, requestId, source, action,
        error: error ? String(error.message ?? error) : undefined,
      });
    },

    /**
     * What happened after a judgement, written as a follow-up keyed by tick so
     * the outcome is attached without holding the row open.
     */
    outcome({ tick, windowMs, dmgDealt, dmgTaken, hpDelta, mpDelta, note }) {
      write('events', { t: Date.now() - started, kind: 'outcome', tick, windowMs, dmgDealt, dmgTaken, hpDelta, mpDelta, note });
      counts.events++;
    },

    /** Discrete facts worth counting later: a hit, a pickup, a death. */
    event(kind, fields = {}) {
      counts.events++;
      write('events', { t: Date.now() - started, kind, ...fields });
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

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * The per-tick row the executor writes. Written as a function rather than a
 * comment so the shape stays in one place and cannot drift.
 */
export const tickRow = ({ tick, me, threats, items, action, source, reflex }) => ({
  tick,
  me: { frame: me.frame, state: me.state, hp: me.hp, mp: me.mp, x: me.x, z: me.z,
        facing: me.facing, holding: me.holding ?? null },
  threats: threats.map((e) => ({ slot: e.slot, name: e.name, frame: e.frame, state: e.state,
                                 hp: e.hp, dx: e.dx, dz: e.dz, incoming: e.incoming ?? false })),
  items: items.map((i) => ({ slot: i.slot, name: i.name, dx: i.dx, dz: i.dz })),
  action,
  /** `jev`, `reflex`, or `fallback` — the only way to attribute performance. */
  source,
  reflex: reflex ?? null,
});
