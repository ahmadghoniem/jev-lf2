/**
 * What every script under scripts/ needs: flags, the API key, and run data.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';

/** `--name value`, or the fallback when the flag is absent. */
export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

/** Whether a bare `--name` flag was passed. */
export const has = (name) => process.argv.includes(`--${name}`);

/** Loads `TYPESAFE_API_KEY` from the repo's `.env` unless the environment already has it. */
export function loadApiKey(envFile = new URL('../.env', import.meta.url)) {
  if (process.env.TYPESAFE_API_KEY || !existsSync(envFile)) return;
  const found = readFileSync(envFile, 'utf8').match(/^TYPESAFE_API_KEY=(.+)$/m);
  if (found) process.env.TYPESAFE_API_KEY = found[1].trim();
}

/** The newest recorded run under runs/, as a path. */
export function latestRun(dir = 'runs') {
  const id = readdirSync(dir).filter((d) => /^\d{4}-/.test(d) && existsSync(`${dir}/${d}/ticks.jsonl`))
    .sort().at(-1);
  if (!id) throw new Error(`no recorded runs under ${dir}/`);
  return `${dir}/${id}`;
}

/** One parsed row per line; a torn last line from a killed run is skipped. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return rows;
}
