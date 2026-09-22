/**
 * Summarizes the PixiJS display list under `pixiGameScene`.
 *
 *   node scripts/scene-dump.mjs            # direct children
 *   node scripts/scene-dump.mjs 2          # two levels deep
 *
 * Unlike a scope, a display object is a real object, so the whole walk runs in
 * one page-side call.
 */
import { connect } from '../src/cdp/client.mjs';

const depth = Number(process.argv[2] ?? 1);

const PIXI_KEYS = new Set(['_events','_eventsCount','tempDisplayObjectParent','transform','alpha','visible',
  'renderable','cullable','cullArea','parent','worldAlpha','_lastSortedIndex','_zIndex','filterArea','filters',
  '_enabledFilters','_bounds','_localBounds','_boundsID','_boundsRect','_localBoundsRect','_mask','_maskRefCount',
  '_destroyed','isSprite','isMask','children','sortableChildren','sortDirty','_texture','_anchor','_width','_height',
  '_tint','_tintRGB','uvs','vertexData','indices','blendMode','shader','pluginName','_roundPixels','_transformID',
  '_textureID','_transformTrimmedID','_textureTrimmedID','vertexTrimmedData','_cachedTint','uvArray','size','start',
  '_font','_text','_style','_autoResolution','_resolution','localStyleID','dirty','_textureCache','maxLineHeight',
  'accessible','accessibleTitle','accessibleHint','accessibleType','tabIndex','interactive','interactiveChildren',
  'hitArea','eventMode','_internalEventMode','_internalInteractive','_accessibleActive','_accessibleDiv',
  'accessibleChildren','accessiblePointerEvents','_trackedPointers','_didTextureUpdate','_lastObjectRendered']);

const WALK = `function (depth, pixiKeys) {
  const skip = new Set(pixiKeys);
  const describe = (o) => {
    const own = Object.keys(o).filter((k) => !skip.has(k));
    return {
      cls: (o.constructor && o.constructor.name) || '?',
      x: Math.round(o.x), y: Math.round(o.y),
      vis: o.visible, n: (o.children || []).length,
      own: own.slice(0, 40),
      text: typeof o.text === 'string' ? o.text.slice(0, 24) : undefined,
    };
  };
  const walk = (o, d) => {
    const node = describe(o);
    if (d > 0 && o.children) node.kids = o.children.map((c) => walk(c, d - 1));
    return node;
  };
  return JSON.stringify(walk(this, depth));
}`;

const cdp = await connect();
const scope = await cdp.scopeVars();
const props = scope.vars;
const scene = props.find((p) => p.name === 'pixiGameScene')?.value;
if (!scene?.objectId) { console.error('pixiGameScene not in scope'); process.exit(1); }

const r = await cdp.send('Runtime.callFunctionOn', {
  objectId: scene.objectId,
  functionDeclaration: WALK,
  returnByValue: true,
  arguments: [{ value: depth }, { value: [...PIXI_KEYS] }],
});
if (r.result?.exceptionDetails) { console.error(r.result.exceptionDetails.text); process.exit(1); }

const print = (n, indent = '', i = '') => {
  const own = n.own.length ? ` own:[${n.own.join(' ')}]` : '';
  const txt = n.text ? ` "${n.text}"` : '';
  console.log(`${indent}${i}${n.cls} (${n.x},${n.y}) kids=${n.n}${n.vis ? '' : ' hidden'}${txt}${own}`);
  (n.kids ?? []).forEach((k, j) => print(k, indent + '  ', `[${j}] `));
};
print(JSON.parse(r.result.result.value));
cdp.close();
