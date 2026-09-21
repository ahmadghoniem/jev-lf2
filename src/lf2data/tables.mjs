/**
 * Loads the generated tables once and caches them.
 *
 * Everything under build/ comes from `scripts/build-move-tables.mjs`, which
 * parses the game's own data files. The executor reads it on every tick, so it
 * is loaded eagerly and per-character frame data lazily — 23 characters is
 * 6000 frames and only the ones actually in the match are worth holding.
 */

import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(`build/${name}.json`, 'utf8'));

export const profiles = load('_profiles');
export const weapons = load('_weapons');
export const objects = load('_objects');
export const index = load('_index');

/** data-file id → its registry row, which is how a live entity finds its file. */
const byId = new Map(index.map((row) => [row.id, row]));

const frameCache = new Map();

/** The parsed frames of whatever data file this entity came from. */
export function framesFor(dataId) {
  if (frameCache.has(dataId)) return frameCache.get(dataId);
  const row = byId.get(dataId);
  const frames = row ? load(row.file).frames : null;
  frameCache.set(dataId, frames);
  return frames;
}

/** The derived fighting profile for a live fighter, keyed the way it is stored. */
export const profileFor = (name) => profiles[name?.toLowerCase()] ?? null;

/** Frame states that mean the fighter cannot act on input right now. */
export const BUSY_STATES = new Set([11, 12, 14, 16]); // injured, falling, lying, dizzy
