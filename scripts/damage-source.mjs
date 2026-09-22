/**
 * Where the damage came from in a run: for every HP drop, what we were doing,
 * what the nearest enemy was doing, whether a weapon was in flight, and whether
 * we blocked or dodged in the six ticks before.
 *
 *   node scripts/damage-source.mjs                 # the newest run
 *   node scripts/damage-source.mjs runs/<run>
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';

const latestRun = () => readdirSync('runs').filter((d) => /^\d{4}-/.test(d)
  && existsSync(`runs/${d}/ticks.jsonl`)).sort().at(-1);

const run = process.argv[2] ?? `runs/${latestRun()}`;
const rows = readFileSync(`${run}/ticks.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const drops = [];
for (let i = 1; i < rows.length; i++) {
  if (!rows[i - 1]?.me || !rows[i]?.me) continue;
  const a = rows[i - 1].me, b = rows[i].me;
  if (b.hp < a.hp && b.hp > 0) drops.push({ i, dmg: a.hp - b.hp, r: rows[i] });
}

console.log(`run ${run}: ${drops.length} damage events, ${drops.reduce((s, d) => s + d.dmg, 0)} hp lost`);
for (const d of drops) {
  const before = rows.slice(Math.max(0, d.i - 6), d.i + 1);
  const th = d.r.threats[0];
  const wpn = d.r.items?.filter((x) => x.inFlight)
    .map((x) => `${x.name}@${Math.round(x.range)}z${Math.round(x.dz)}`).join('+') || '-';
  // Was a weapon in flight in the 6 ticks before, and did we block?
  const blocked = before.some((b) => b.me.doing === 'blocking');
  const dodgeStep = before.some((b) => b.action === 'dodge');
  console.log(
    `t${String(d.r.tick).padStart(5)} dmg ${String(d.dmg).padStart(3)}` +
    ` me=${d.r.me.doing.padEnd(10)} enemy=${(th?.doing ?? '-').padEnd(12)} f=${String(th?.frame).padStart(3)}` +
    ` dx=${String(Math.round(th?.dx ?? 0)).padStart(4)} dz=${String(Math.round(th?.dz ?? 0)).padStart(3)}` +
    ` wpn=${wpn.padEnd(16)} blockedBefore=${blocked ? 1 : 0} dodged=${dodgeStep ? 1 : 0}` +
    ` act=${d.r.action}/${d.r.source}`
  );
}
