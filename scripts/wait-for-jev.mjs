/**
 * Waits until Jev replies fast enough to play a game that measures the code.
 * Exits 0 when the median of PROBE_ASKS replayed real asks is at most
 * `--max-reply-ms`, checking once a minute; exits 1 after `--wait-min`
 * minutes. series.mjs runs it before each game.
 *
 *   node scripts/wait-for-jev.mjs --max-reply-ms 400 --wait-min 20
 *
 * A game played while Jev is slow measures the service: on 2026-09-29 the
 * median reply went from 301 ms to 553-558 ms within two hours, and of 20
 * games the 10 with the slowest replies dealt 236 per 1000 ticks against 308.
 * The probe replays the latest recorded ask's state and action options (about
 * 1400 input tokens, against about 2200 for a real ask with its follow-ups).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { arg, loadApiKey } from '../src/cli.mjs';
import { createClient } from '../src/jev/client.mjs';

const maxReplyMs = Number(arg('max-reply-ms', 400));
const waitMin = Number(arg('wait-min', 20));
const PROBE_ASKS = 5;
const DEADLINE_MS = 1400;  // play.mjs's; a miss counts as this

loadApiKey();
const client = createClient();

/** The most recent recorded ask with its state and options. */
function recordedAsk() {
  for (const d of readdirSync('runs').filter((x) => /^\d{4}-/.test(x)).sort().reverse()) {
    if (!existsSync(`runs/${d}/judgements.jsonl`)) continue;
    for (const l of readFileSync(`runs/${d}/judgements.jsonl`, 'utf8').trim().split('\n').reverse()) {
      try { const j = JSON.parse(l); if (j.state && j.criteria?.action && j.model) return j; } catch { /* partial line */ }
    }
  }
  return null;
}

async function replyMs(row) {
  const questions = { action: { type: 'choice',
    instructions: 'Choose what to do next in this fight. Every option listed is available right now.',
    criteria: row.criteria.action } };
  const took = [];
  for (let i = 0; i < PROBE_ASKS; i++) {
    const t0 = Date.now();
    const a = await client.ask({ state: row.state, questions, deadlineMs: DEADLINE_MS });
    took.push(a ? Date.now() - t0 : DEADLINE_MS);
  }
  return took.sort((a, b) => a - b)[PROBE_ASKS >> 1];
}

const row = recordedAsk();
if (!row) { console.log('no recorded ask to probe with; not waiting'); process.exit(0); }
const until = Date.now() + waitMin * 60000;
for (;;) {
  const ms = await replyMs(row);
  if (ms <= maxReplyMs) { console.log(`Jev replies in ${ms} ms (median of ${PROBE_ASKS})`); process.exit(0); }
  if (Date.now() > until) { console.error(`Jev still replies in ${ms} ms after ${waitMin} min`); process.exit(1); }
  console.log(`Jev replies in ${ms} ms, over ${maxReplyMs}; checking again in a minute`);
  await new Promise((r) => setTimeout(r, 60000));
}
