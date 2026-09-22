/**
 * Walks a script-scope variable and prints what is inside it.
 *
 *   node scripts/inspect.mjs KUKH            # the variable itself
 *   node scripts/inspect.mjs KUKH 0 2        # KUKH[0][2]
 *
 * Scope variables are only reachable as CDP remote objects, so every level of
 * the path costs a getProperties round trip.
 */
import { connect } from '../src/cdp/client.mjs';

const [name, ...path] = process.argv.slice(2);
if (!name) { console.error('usage: node scripts/inspect.mjs VAR [key ...]'); process.exit(1); }

const cdp = await connect();
const scope = await cdp.scopeVars();
const props = scope.vars;
let here = props.find((p) => p.name === name)?.value;
if (!here) { console.error(`${name} not in scope (via ${scope.via})`); process.exit(1); }

for (const key of path) {
  if (!here.objectId) { console.error(`cannot descend into ${here.type}`); process.exit(1); }
  const sub = (await cdp.getProps(here.objectId)).result ?? [];
  const next = sub.find((p) => p.name === key);
  if (!next) { console.error(`no key "${key}"; have: ${sub.map((p) => p.name).join(' ')}`); process.exit(1); }
  here = next.value;
}

console.log(`${[name, ...path].join('.')} : ${here.className ?? here.type} ${here.description ?? here.value ?? ''}`);
if (!here.objectId) process.exit(0);

const items = (await cdp.getProps(here.objectId)).result ?? [];
for (const p of items) {
  const v = p.value;
  if (!v) { console.log(`  ${p.name.padEnd(18)} (accessor)`); continue; }
  if (v.type === 'object' && v.objectId) {
    const sub = (await cdp.getProps(v.objectId)).result ?? [];
    const keys = sub.map((x) => x.name).filter((n) => n !== '__proto__');
    console.log(`  ${p.name.padEnd(18)} ${v.className ?? '?'} (${keys.length}) ${keys.slice(0, 22).join(' ')}`);
  } else {
    console.log(`  ${p.name.padEnd(18)} ${v.type} ${String(v.description ?? v.value).slice(0, 70)}`);
  }
}
cdp.close();
