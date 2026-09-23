/**
 * What was happening around each note typed during a pause.
 *
 * Pausing the game (Esc) during a run opens a note box; each note is logged
 * against the tick the pause began on. This prints, for every note, the
 * seconds before and just after it: what Jev was offered and chose, what the
 * reflex layer did, and every change in what either fighter was doing, with
 * the damage taken.
 *
 *   node scripts/notes.mjs runs/<id>
 *   node scripts/notes.mjs runs/<id> --before 120 --after 30
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { arg, readJsonl } from '../src/cli.mjs';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'ticks.jsonl'))) {
  console.error('usage: node scripts/notes.mjs runs/<id> [--before ticks] [--after ticks]');
  process.exit(1);
}
const BEFORE = Number(arg('before', 90));
const AFTER = Number(arg('after', 30));

const notes = existsSync(join(dir, 'notes.jsonl')) ? readJsonl(join(dir, 'notes.jsonl')) : [];
if (!notes.length) { console.log('no notes in this run'); process.exit(0); }
const ticks = readJsonl(join(dir, 'ticks.jsonl')).filter((t) => t.me);
const judgements = readJsonl(join(dir, 'judgements.jsonl'));

const secs = (t) => `${(t / 1000).toFixed(1)}s`;
const top = (probs, n = 3) => Object.entries(probs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, p]) => `${k} ${Math.round(p * 100)}%`).join(', ');

for (const note of notes) {
  const at = ticks.find((t) => t.tick >= note.tick) ?? ticks.at(-1);
  console.log(`\n=== tick ${note.tick} (${secs(at?.t ?? 0)}): "${note.text}"`);

  const lo = note.tick - BEFORE;
  const hi = note.tick + AFTER;
  const window = ticks.filter((t) => t.tick >= lo && t.tick <= hi);
  const asked = new Map(judgements.filter((j) => j.tick >= lo && j.tick <= hi).map((j) => [j.tick, j]));

  let prev = null;
  for (const t of window) {
    const foe = t.threats?.[0];
    const lines = [];
    const j = asked.get(t.tick);
    if (j) {
      lines.push(`asked: ${Object.keys(j.criteria?.action ?? {}).length} options -> ${j.action ?? 'no answer'}`
        + ` (${top(j.answers?.action?.probabilities)}${j.latencyMs ? `; ${j.latencyMs} ms` : ''})`);
    }
    const doing = `${t.source}:${t.action} | me ${t.me.doing}${foe ? ` | ${foe.name} ${foe.doing} dx ${foe.dx} dz ${foe.dz}` : ''}`;
    const prevDoing = prev && `${prev.source}:${prev.action} | me ${prev.me.doing}${prev.threats?.[0] ? ` | ${prev.threats[0].name} ${prev.threats[0].doing}` : ''}`;
    const changed = !prev || !doing.startsWith(prevDoing ?? '\0');
    const lost = prev ? prev.me.hp - t.me.hp : 0;
    const dealt = prev && foe && prev.threats?.[0] ? prev.threats[0].hp - foe.hp : 0;
    if (changed || lost > 0 || dealt > 0 || j || t === at) {
      const mark = t === at ? '>>' : '  ';
      const hurt = [lost > 0 ? `took ${lost}` : '', dealt > 0 ? `dealt ${dealt}` : ''].filter(Boolean).join(', ');
      const flying = (t.items ?? []).filter((i) => i.hostile && i.inFlight)
        .map((i) => `${i.name} at ${i.range}`).join(', ');
      console.log(`${mark} ${String(t.tick).padStart(5)} ${secs(t.t).padStart(6)}  hp ${String(t.me.hp).padStart(3)} mp ${String(t.me.mp).padStart(3)}  ${doing}`
        + (t.reflex ? `  [reflex: ${t.reflex}]` : '')
        + (flying ? `  [in flight: ${flying}]` : '')
        + (hurt ? `  ** ${hurt}` : ''));
      for (const l of lines) console.log(`${' '.repeat(18)}${l}`);
    }
    prev = t;
  }
}
