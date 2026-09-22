/**
 * Lists the closure scopes of a function reached by a path through the script
 * scope, and what each scope holds.
 *
 *   node scripts/fn-scopes.mjs app _ticker _head next fn
 *   node scripts/fn-scopes.mjs DQcu
 */
import { connect } from '../src/cdp/client.mjs';

const path = process.argv.slice(2);
const cdp = await connect();
const scope = await cdp.scopeVars();
const props = scope.vars;
let here = props.find((p) => p.name === path[0])?.value;
if (!here) { console.error(`${path[0]} not in scope`); process.exit(1); }

for (const key of path.slice(1)) {
  const sub = (await cdp.getProps(here.objectId)).result ?? [];
  const next = sub.find((p) => p.name === key);
  if (!next) { console.error(`no key "${key}"`); process.exit(1); }
  here = next.value;
}

const { internalProperties = [] } = await cdp.getProps(here.objectId, false);
const scopes = internalProperties.find((p) => p.name === '[[Scopes]]');
if (!scopes) { console.log('no [[Scopes]]:', internalProperties.map((p) => p.name).join(' ')); process.exit(0); }

const list = (await cdp.getProps(scopes.value.objectId)).result ?? [];
for (const [i, s] of list.entries()) {
  const vars = (await cdp.getProps(s.value.objectId)).result ?? [];
  console.log(`[${i}] ${s.value.description}: ${vars.length} vars`);
  if (s.value.description === 'Global') continue;
  for (const v of vars) {
    const val = v.value;
    const shown = !val ? '(accessor)'
      : val.type === 'object' ? `${val.className ?? '?'} ${val.description ?? ''}`.slice(0, 60)
      : `${val.type} ${String(val.description ?? val.value).slice(0, 48)}`;
    console.log(`     ${v.name.padEnd(16)} ${shown}`);
  }
}
cdp.close();
