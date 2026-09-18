/**
 * Parses every _res_data file, writes machine-readable tables to build/, and
 * prints a summary so the parse can be eyeballed for damage.
 *
 *   node scripts/build-move-tables.mjs [--json]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDataFile, buildMoveTable, buildThreatTable } from '../src/lf2data/parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = 'C:/LF2-Remastered/LF2-Remastered(The Game)/resources/app/_res_data';
const OUT_DIR = join(ROOT, 'build');

const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('-r.txt'));
mkdirSync(OUT_DIR, { recursive: true });

const index = [];
let totalFrames = 0;
let totalMoves = 0;
let totalThreats = 0;

for (const file of files) {
  const text = readFileSync(join(DATA_DIR, file), 'utf8');
  const { header, frames } = parseDataFile(text);
  const moves = buildMoveTable(frames);
  const threats = buildThreatTable(frames);

  totalFrames += frames.size;
  totalMoves += moves.length;
  totalThreats += threats.size;

  const name = file.replace(/-r\.txt$/, '');
  writeFileSync(
    join(OUT_DIR, `${name}.json`),
    JSON.stringify(
      {
        name: header.name ?? name,
        header,
        frames: Object.fromEntries(frames),
        moves,
        threatFrames: Object.fromEntries(threats),
      },
      null,
      process.argv.includes('--json') ? 2 : 0,
    ),
  );

  index.push({
    file: name,
    character: header.name ?? null,
    frames: frames.size,
    moves: moves.length,
    threatFrames: threats.size,
    wsl: header.wsl.length,
  });
}

writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify(index, null, 2));

console.log(`parsed ${files.length} files -> ${OUT_DIR}`);
console.log(`  frames ${totalFrames}, moves ${totalMoves}, damaging frames ${totalThreats}\n`);

const wide = index.filter((r) => r.moves > 0).sort((a, b) => b.moves - a.moves);
console.log('character              frames  moves  damaging');
for (const r of wide.slice(0, 14)) {
  console.log(
    `${(r.character ?? r.file).padEnd(22)} ${String(r.frames).padStart(6)} ${String(r.moves).padStart(6)} ${String(r.threatFrames).padStart(9)}`,
  );
}

// Spot-check one character's move table, since a silent mis-parse looks like success.
const davis = JSON.parse(readFileSync(join(OUT_DIR, 'davis.json'), 'utf8'));
console.log('\nDavis moves (input -> entry frame, mp, startup ticks, damage):');
for (const m of davis.moves) {
  const dmg = m.injury != null ? `${m.injury} dmg` : m.spawns ? `spawns ${m.spawns.join(',')}` : 'unresolved';
  console.log(
    `  ${m.input.padEnd(3)} -> f${String(m.target).padEnd(4)} ${String(m.name ?? '-').padEnd(20)} mp ${String(m.mp ?? 0).padStart(4)}  ${String(m.startupTicks ?? '-').padStart(3)}t  ${dmg}`,
  );
}
