/**
 * How the dodge did against every thrown weapon in a run: each projectile
 * episode from first flag to last, when the dodge fired, and whether the weapon
 * hit anyway.
 *
 *   node scripts/dodge-analysis.mjs                # the newest run
 *   node scripts/dodge-analysis.mjs runs/<a> runs/<b>
 */
import { latestRun, readJsonl } from '../src/cli.mjs';

const runs = process.argv.slice(2).length ? process.argv.slice(2) : [latestRun()];

for (const run of runs) {
  const rows = readJsonl(`${run}/ticks.jsonl`);
  console.log(`\n=== ${run} ===`);

  // Projectile episodes: a weapon flagged inFlight+closing, from first flag to
  // last, with the speed measured at each read.
  const episodes = [];
  let cur = null;
  for (const r of rows) {
    const f = (r.items ?? []).find((i) => i.inFlight && i.closing && i.range <= 200);
    if (f) {
      if (!cur || cur.slot !== f.slot) { if (cur) episodes.push(cur); cur = { slot: f.slot, name: f.name, ticks: [] }; }
      cur.ticks.push({ tick: r.tick, range: Math.round(f.range), dz: Math.round(f.dz), speed: f.speed ?? 0,
        act: r.action, src: r.source, hp: r.me.hp, doing: r.me.doing });
    } else if (cur) { episodes.push(cur); cur = null; }
  }
  if (cur) episodes.push(cur);

  console.log(`projectile episodes: ${episodes.length}`);
  for (const e of episodes) {
    const first = e.ticks[0], last = e.ticks[e.ticks.length - 1];
    // damage within the episode or the 3 ticks after
    const iEnd = rows.findIndex((r) => r.tick >= last.tick);
    const after = rows.slice(Math.max(0, iEnd - 2), iEnd + 4);
    const dmg = after.some((r, i) => i > 0 && r.me && after[i - 1].me && r.me.hp < after[i - 1].me.hp && r.me.hp > 0);
    const speeds = e.ticks.map((t) => t.speed).filter((s) => s > 0);
    const dodgeTicks = e.ticks.filter((t) => t.act === 'dodge').length;
    const firstDodge = e.ticks.find((t) => t.act === 'dodge');
    console.log(
      `  ${e.name}#${e.slot}: ${e.ticks.length} ticks, r ${first.range}->${last.range}, ` +
      `dz ${first.dz}->${last.dz}, speed p50 ${speeds.length ? speeds.sort((a, b) => a - b)[Math.floor(speeds.length / 2)] : '-'}, ` +
      `dodge ${dodgeTicks}/${e.ticks.length}${firstDodge ? ` from r${firstDodge.range}` : ' (never)'}, ` +
      `dmg ${dmg ? 'YES' : 'no'}`);
  }
}
