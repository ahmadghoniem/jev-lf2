/**
 * Parses every _res_data file and writes the tables the harness runs on:
 * per-object frames, move tables, threat frames, and a fighting profile for
 * each character.
 *
 *   node scripts/build-move-tables.mjs [--json]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDataFile, buildMoveTable, buildThreatTable } from '../src/lf2data/parse.mjs';
import { buildProfile, buildObjectIndex } from '../src/lf2data/profile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = 'C:/LF2-Remastered/LF2-Remastered(The Game)/resources/app/_res_data';
const OUT_DIR = join(ROOT, 'build');

/** `id: 11  type: 0  file: _res_data/davis-r` — the object registry. */
function parseRegistry(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^id:\s*(\d+)\s+type:\s*(\d+)\s+file:\s*(\S+)/.exec(line.trim());
    if (m) rows.push({ id: Number(m[1]), type: Number(m[2]), file: `${basename(m[3])}.txt` });
  }
  return rows;
}

const registry = parseRegistry(readFileSync(join(DATA_DIR, '_data.txt'), 'utf8'));
const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('-r.txt'));
mkdirSync(OUT_DIR, { recursive: true });

const parsed = new Map();   // file -> { header, frames }
for (const file of files) parsed.set(file, parseDataFile(readFileSync(join(DATA_DIR, file), 'utf8')));

// Object ids come from the registry, not from the files, which carry no id.
const byId = new Map();
for (const r of registry) {
  const p = parsed.get(r.file);
  if (p) byId.set(r.id, { header: { ...p.header, id: r.id, type: r.type }, frames: p.frames });
}
const objects = buildObjectIndex(byId);

const index = [];
const profiles = {};
let totalFrames = 0;
let totalMoves = 0;
let totalThreats = 0;

for (const [file, { header, frames }] of parsed) {
  const reg = registry.find((r) => r.file === file);
  const moves = buildMoveTable(frames);
  const threats = buildThreatTable(frames);
  totalFrames += frames.size;
  totalMoves += moves.length;
  totalThreats += threats.size;

  const name = file.replace(/-r\.txt$/, '');
  const record = {
    name: header.name ?? name,
    id: reg?.id ?? null,
    type: reg?.type ?? null,
    header,
    frames: Object.fromEntries(frames),
    moves,
    threatFrames: Object.fromEntries(threats),
  };

  if (reg?.type === 0 && name !== 'template') {
    record.profile = buildProfile(header.name ?? name, frames, objects);
    profiles[name] = record.profile;
  }

  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(record, null, process.argv.includes('--json') ? 2 : 0));
  index.push({ file: name, character: header.name ?? null, id: reg?.id ?? null, type: reg?.type ?? null,
               frames: frames.size, moves: moves.length, threatFrames: threats.size, wsl: header.wsl.length });
}

writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify(index, null, 2));
writeFileSync(join(OUT_DIR, '_profiles.json'), JSON.stringify(profiles, null, 2));
writeFileSync(join(OUT_DIR, '_objects.json'), JSON.stringify(Object.fromEntries(objects), null, 2));

// Weapon damage lives in the weapon's own <wsl> table, not in the character's
// frames, so it is emitted separately for the executor to price at run time.
const weapons = {};
for (const [id, { header }] of byId) {
  if (!header.wsl?.length) continue;
  const byAttack = {};
  for (const row of header.wsl) byAttack[row.attack] = row;
  weapons[id] = { id, name: header.name, type: header.type, attacks: byAttack,
                  weaponHp: header.weapon_hp ?? null, dropHurt: header.weapon_drop_hurt ?? null };
}
writeFileSync(join(OUT_DIR, '_weapons.json'), JSON.stringify(weapons, null, 2));

console.log(`parsed ${files.length} files -> ${OUT_DIR}`);
console.log(`  frames ${totalFrames}, moves ${totalMoves}, damaging frames ${totalThreats}`);
console.log(`  profiles ${Object.keys(profiles).length}, objects ${objects.size}\n`);

console.log(`  weapons with damage tables ${Object.keys(weapons).length}
`);
console.log('character       archetype  bare reach  cheapest ranged mp  basic attack');
for (const [file, p] of Object.entries(profiles).sort((a, b) => a[1].archetype.localeCompare(b[1].archetype) || a[0].localeCompare(b[0]))) {
  const basic = p.basicAttack ? `${p.basicAttack.kind} ${p.basicAttack.damage} dmg` : '-';
  console.log(
    `${(p.name ?? file).padEnd(15)} ${p.archetype.padEnd(10)} ${String(p.meleeReach).padStart(10)} ${String(p.cheapestRangedMp ?? '-').padStart(19)}  ${basic}`,
  );
}
