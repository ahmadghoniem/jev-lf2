/**
 * Counts live instances of every class in the game's script scope.
 *
 *   node scripts/find-instances.mjs            # all classes with >0 instances
 *   node scripts/find-instances.mjs Kahe       # dump the instances of one class
 *
 * `Runtime.queryObjects` walks the heap for objects with a given prototype,
 * which is how the fighter objects are found without knowing where the bundle
 * stores them.
 */
import { connect } from '../src/cdp/client.mjs';

const only = process.argv[2];
const cdp = await connect();
const scope = await cdp.scriptScope();
const props = (await cdp.getProps(scope.objectId)).result ?? [];

const classes = props.filter((p) =>
  p.value?.type === 'function' && /^class /.test(p.value.description ?? ''));

async function instancesOf(entry) {
  const own = (await cdp.getProps(entry.value.objectId)).result ?? [];
  const proto = own.find((p) => p.name === 'prototype')?.value;
  if (!proto?.objectId) return null;
  const r = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.objectId });
  const arr = r.result?.objects;
  if (!arr?.objectId) return null;
  const items = (await cdp.getProps(arr.objectId)).result ?? [];
  return items.filter((p) => p.name !== 'length');
}

if (only) {
  const entry = classes.find((c) => c.name === only);
  if (!entry) { console.error(`no class ${only}`); process.exit(1); }
  const items = await instancesOf(entry);
  console.log(`${only}: ${items.length} instances`);
  for (const [i, it] of items.entries()) {
    const fields = (await cdp.getProps(it.value.objectId)).result ?? [];
    const shown = fields
      .filter((f) => f.value && f.value.type !== 'function')
      .map((f) => `${f.name}=${f.value.type === 'object'
        ? (f.value.className ?? f.value.subtype ?? 'obj')
        : String(f.value.value).slice(0, 14)}`);
    console.log(`\n  [${i}] ${shown.join(' ')}`);
  }
} else {
  const rows = [];
  for (const c of classes) {
    const items = await instancesOf(c);
    if (items?.length) rows.push({ name: c.name, n: items.length, src: (c.value.description ?? '').slice(6, 90) });
  }
  rows.sort((a, b) => a.n - b.n);
  for (const r of rows) console.log(`${String(r.n).padStart(5)}  ${r.name.padEnd(10)} ${r.src}`);
  console.log(`\n${rows.length} of ${classes.length} classes have live instances`);
}
cdp.close();
