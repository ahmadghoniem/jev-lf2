/**
 * Snapshots the game's script scope, so the fighter objects can be found by
 * diffing a menu against a live match.
 *
 *   node scripts/scope-snapshot.mjs menu            # writes runs/scope-menu.json
 *   node scripts/scope-snapshot.mjs match
 *   node scripts/scope-snapshot.mjs --diff menu match
 *   node scripts/scope-snapshot.mjs --watch NAME    # print one var every 500ms
 *
 * The whole scope is summarized in one page-side call rather than a
 * getProperties round trip per variable, which keeps a snapshot under a second.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from '../src/cdp/client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'runs');

/**
 * A scope is not a real object — `callFunctionOn` against it sees almost
 * nothing, so its variables have to come from `getProperties`. That single call
 * already carries each value's type and class; only non-empty arrays and plain
 * objects need a second call to sample what is inside them.
 */
async function snapshot(cdp, { sampleDepth = 1 } = {}) {
  const scope = await cdp.scriptScope();
  const props = (await cdp.getProps(scope.objectId)).result ?? [];
  const vars = {};

  for (const p of props) {
    const v = p.value;
    if (!v) { vars[p.name] = { t: 'unreadable' }; continue; }
    if (v.type !== 'object' && v.type !== 'function') {
      vars[p.name] = { t: v.type, v: v.type === 'string' ? String(v.value).slice(0, 60) : v.value };
      continue;
    }
    if (v.type === 'function') { vars[p.name] = { t: 'function', name: v.description?.slice(0, 40) }; continue; }
    if (v.subtype === 'null') { vars[p.name] = { t: 'null' }; continue; }

    const len = /^Array\((\d+)\)/.exec(v.description ?? '');
    if (v.subtype === 'array') {
      const n = len ? Number(len[1]) : 0;
      const entry = { t: 'array', len: n, cls: v.className };
      if (n > 0 && sampleDepth > 0) entry.el = await sampleArray(cdp, v.objectId, n);
      vars[p.name] = entry;
      continue;
    }
    const entry = { t: 'object', cls: v.className ?? '?', desc: v.description?.slice(0, 40) };
    if (sampleDepth > 0) {
      const sub = (await cdp.getProps(v.objectId)).result ?? [];
      entry.nkeys = sub.length;
      entry.keys = sub.map((x) => x.name).filter((n) => n !== '__proto__').slice(0, 30);
    }
    vars[p.name] = entry;
  }
  return { scope: `Script via ${scope.via}`, count: props.length, vars };
}

/** First few elements of an array, described by class and key names. */
async function sampleArray(cdp, objectId, len) {
  const items = (await cdp.getProps(objectId)).result ?? [];
  const out = [];
  for (const it of items.slice(0, Math.min(3, len))) {
    const v = it.value;
    if (!v) continue;
    if (v.type !== 'object') { out.push(`${v.type}:${String(v.value).slice(0, 20)}`); continue; }
    const sub = (await cdp.getProps(v.objectId)).result ?? [];
    out.push(`${v.className ?? '?'}{${sub.map((x) => x.name).slice(0, 14).join(',')}}`);
  }
  return out;
}

function describe(e) {
  if (!e) return '(absent)';
  if (e.t === 'array') return `array(${e.len})${e.el ? ' [' + e.el.join(' | ') + ']' : ''}`;
  if (e.t === 'object') return `${e.cls}{${e.nkeys} keys: ${e.keys.join(',')}}`;
  if (e.t === 'function') return `fn ${e.name}/${e.arity}`;
  return `${e.t} ${e.v ?? ''}`;
}

const args = process.argv.slice(2);

if (args[0] === '--diff') {
  const [a, b] = [args[1], args[2]].map((l) =>
    JSON.parse(readFileSync(join(RUNS, `scope-${l}.json`), 'utf8')));
  const names = [...new Set([...Object.keys(a.vars), ...Object.keys(b.vars)])].sort();

  // Numbers drift every tick; what matters is a variable changing shape.
  const structural = (e) => (e ? (e.t === 'array' ? `array/${e.len}` : e.t === 'object' ? `object/${e.cls}` : e.t) : 'absent');
  const rows = [];
  for (const n of names) {
    const [x, y] = [a.vars[n], b.vars[n]];
    if (structural(x) === structural(y)) continue;
    rows.push({ n, from: describe(x), to: describe(y) });
  }
  for (const r of rows) console.log(`${r.n}
    ${args[1]}: ${r.from}
    ${args[2]}: ${r.to}`);
  console.log(`
${rows.length} of ${names.length} variables changed shape`);
  process.exit(0);
}

const cdp = await connect({ quiet: false });

if (args[0] === '--watch') {
  const name = args[1];
  for (let i = 0; i < 40; i++) {
    const s = await snapshot(cdp);
    console.log(`${String(i).padStart(3)} ${describe(s.vars[name])}`);
    await sleep(500);
  }
} else {
  const label = args[0] ?? 'snapshot';
  const s = await snapshot(cdp);
  mkdirSync(RUNS, { recursive: true });
  const out = join(RUNS, `scope-${label}.json`);
  writeFileSync(out, JSON.stringify(s, null, 2));
  const byKind = {};
  for (const e of Object.values(s.vars)) byKind[e.t] = (byKind[e.t] ?? 0) + 1;
  console.log(`${s.scope}: ${s.count} vars -> ${out}`);
  console.log(Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', '));
  const arrays = Object.entries(s.vars).filter(([, e]) => e.t === 'array' && e.len > 0);
  console.log(`\nnon-empty arrays (${arrays.length}):`);
  for (const [n, e] of arrays.slice(0, 40)) console.log(`  ${n.padEnd(12)} ${describe(e)}`);
}
cdp.close();
