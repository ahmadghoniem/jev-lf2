/**
 * Reads the live entity table out of a running match.
 *
 * The game keeps a fixed pool of 400 entity objects (class `LWAh`) covering
 * fighters, weapons, projectiles and debris alike. The pool is not referenced
 * from any global, so it is found by heap query on the class prototype, and
 * every read after that is one `callFunctionOn` — the whole arena in a single
 * round trip.
 *
 * Each entity carries `e0`, its parsed data file, which is what joins a live
 * object to the tables in build/ (name, filename, id, type).
 */

/** Class names in the bundle, matched to what they hold by instance count. */
export const CLASSES = {
  entity: 'LWAh',   // 400 pooled game objects
  frame: 'GDLT',    // 5974, one per parsed frame
  bdy: '_IUN',      // 5070
  wpoint: 'UNzS',   // 4152
  bpoint: 'LFN6',   // 2906
  itr: 'WlEE',      // 1979
  cpoint: 'AkRS',   // 521
  opoint: 'Kahe',   // 114
  dataFile: 'TIJj', // 65, one per _res_data file
  sprite: 'HJUP',
};

/** Fields on the data file object (`entity.e0`) that identify it. */
const IDENTITY = ['name', 'filename', 'id', 'type'];

/** Resolves a class name in the script scope to its prototype's objectId. */
export async function classPrototype(cdp, className) {
  const { vars } = await cdp.scopeVars();
  const cls = vars.find((p) => p.name === className)?.value;
  if (!cls?.objectId) throw new Error(`class ${className} not in script scope`);
  const own = (await cdp.getProps(cls.objectId)).result ?? [];
  const proto = own.find((p) => p.name === 'prototype')?.value;
  if (!proto?.objectId) throw new Error(`class ${className} has no prototype`);
  return proto.objectId;
}

/**
 * A handle on the entity pool. Held across ticks so the heap query and the
 * scope walk happen once, not every frame.
 */
export async function openEntityPool(cdp, className = CLASSES.entity) {
  const prototypeObjectId = await classPrototype(cdp, className);
  const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId });
  const poolId = q.result?.objects?.objectId;
  if (!poolId) throw new Error(`queryObjects returned nothing for ${className}`);

  /** Every entity that is actually in play, with its identity resolved. */
  const read = async () => {
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId: poolId,
      returnByValue: true,
      functionDeclaration: READ_LIVE,
      arguments: [{ value: IDENTITY }],
    });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return JSON.parse(r.result.result.value);
  };

  return { read, poolId };
}

/**
 * Runs in the page. An entity counts as in play when it has a position — the
 * unused slots in the pool sit at the origin with no data file attached.
 */
const READ_LIVE = `function (identity) {
  const out = [];
  for (const o of this) {
    if (o.x === 0 && o.z === 0) continue;
    const e = { slot: o.index };
    const d = o.e0;
    if (d) for (const k of identity) e[k] = d[k];
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === null || v === undefined) continue;
      const t = typeof v;
      if (t === 'number' || t === 'boolean' || t === 'string') e[k] = v;
    }
    out.push(e);
  }
  return JSON.stringify(out);
}`;

/** Entities that are fighters (data type 0), i.e. players and COMs. */
export const fighters = (live) => live.filter((e) => e.type === 0);
