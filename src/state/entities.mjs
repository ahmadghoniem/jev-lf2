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

  /**
   * The pool on the next game frame: waits in the page, one animation frame at
   * a time, until anything in play has moved or advanced, then reads it in
   * the same round trip. Pacing the loop with timers could not hold 30 Hz on
   * Windows, where a timer sleeps in steps of 15.6 ms: a 13 ms wait took 15.6
   * and a 20 ms one took 31, and the loop ran at 22 Hz. Waiting on the game's
   * own frame keeps one read per frame and misses none.
   */
  let sig = 0;
  const next = async (timeoutMs = 60) => {
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId: poolId,
      returnByValue: true,
      awaitPromise: true,
      functionDeclaration: READ_NEXT,
      arguments: [{ value: IDENTITY }, { value: sig }, { value: timeoutMs }],
    });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    const out = JSON.parse(r.result.result.value);
    sig = out.sig;
    return out.live;
  };

  return { read, next, poolId };
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

const READ_NEXT = `function (identity, lastSig, timeoutMs) {
  const pool = this;
  const read = ${READ_LIVE};
  const sig = () => {
    let s = 0;
    for (const o of pool) {
      if (o.x === 0 && o.z === 0) continue;
      s = (s * 31 + (o.Ts | 0) * 7 + (o.waiting | 0) * 3 + Math.round(o.x * 8) + Math.round(o.y * 8) + Math.round(o.z * 8)) | 0;
    }
    return s;
  };
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const s = sig();
      if (s !== lastSig || performance.now() - t0 > timeoutMs) {
        resolve('{"sig":' + s + ',"live":' + read.call(pool, identity) + '}');
      } else requestAnimationFrame(step);
    };
    step();
  });
}`;

/** Entities that are fighters (data type 0), i.e. players and COMs. */
export const fighters = (live) => live.filter((e) => e.type === 0);
