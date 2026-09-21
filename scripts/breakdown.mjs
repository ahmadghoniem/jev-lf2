/**
 * Match breakdown — the instrument for reviewing a run with human eyes.
 *
 * `report-run.mjs` answers "how did the policy do" with aggregates. This answers
 * "why did it do that", decision by decision. It joins the judgement stream to
 * the tick stream and reconstructs, for every decision, the situation Jev was
 * shown, the options it was offered, what it chose — and what actually happened
 * in the seconds after the answer landed.
 *
 * Outcomes are derived from `ticks.jsonl` rather than read from `events.jsonl`,
 * because nothing calls `run.outcome()` yet: every recording so far has an empty
 * event stream. Deriving them here means this works on runs already on disk.
 *
 *   node scripts/breakdown.mjs runs/2026-09-19T02-11-24
 *   node scripts/breakdown.mjs runs/<a> --window 2000 --out runs/<a>/breakdown.html
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { label } from '../src/state/options.mjs';
import { REACH_SLACK } from '../src/lf2data/frames.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes(`--${n}`);

/** How far after an answer lands we look for its consequences. */
const WINDOW_MS = Number(arg('window', 1500));

// ---------------------------------------------------------------- loading

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* tolerate a corrupt line */ }
  }
  return out;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// ---------------------------------------------------------------- analysis

/**
 * What an option does, so a breakdown can say whether a chosen attack was
 * actually in range. Derived from the same profile the option builder used, so
 * the names line up.
 */
function resolveAction(name, profile) {
  if (!name || !profile) return { attack: false };
  if (name === 'wait' || name === 'defend' || name === 'close_distance'
    || name === 'open_distance' || name === 'drop_weapon' || name === 'throw_weapon') {
    return { attack: name === 'throw_weapon', ranged: name === 'throw_weapon', reach: Infinity };
  }
  if (name.startsWith('pick_up_') || name.startsWith('drink_')) return { attack: false };

  const basic = profile.basicAttack;
  if (name === 'shoot') {
    return { attack: true, ranged: true, reach: Infinity, damage: basic?.damage };
  }
  if (name.startsWith('special_')) {
    const m = (profile.moves ?? []).find((x) => `special_${label(x)}` === name);
    if (!m) return { attack: true, ranged: false, reach: profile.meleeReach };
    return { attack: true, ranged: m.kind === 'ranged', reach: m.kind === 'ranged' ? Infinity : m.reach, damage: m.damage };
  }
  if (name.includes('swing_')) {
    return { attack: true, ranged: name.startsWith('throw_weapon'), reach: profile.meleeReach };
  }
  const m = (profile.moves ?? []).find((x) => label(x) === name);
  if (m) return { attack: true, ranged: m.kind === 'ranged', reach: m.kind === 'ranged' ? Infinity : m.reach, damage: m.damage };
  return { attack: true, ranged: false, reach: profile.meleeReach };
}

const nearestGap = (tick) => {
  let d = Infinity;
  for (const t of tick?.threats ?? []) {
    const g = Math.hypot(t.dx ?? 0, t.dz ?? 0);
    if (g < d) d = g;
  }
  return d;
};

function analyze(runDir, { windowMs = WINDOW_MS } = {}) {
  const dir = resolve(process.cwd(), runDir);
  const manifest = readJson(join(dir, 'manifest.json'), {});
  const ticks = readJsonl(join(dir, 'ticks.jsonl'));
  const judgements = readJsonl(join(dir, 'judgements.jsonl')).sort((a, b) => a.tick - b.tick);

  const profiles = readJson(join(ROOT, 'build', '_profiles.json'), {});
  const character = (manifest.character ?? '').toLowerCase();
  const profile = profiles[character] ?? null;

  const live = ticks.filter((t) => !t.dead && t.me);
  const startHp = live[0]?.me.hp ?? null;
  const endHp = live[live.length - 1]?.me.hp ?? null;
  let deathTick = null;
  if (ticks.length && ticks[ticks.length - 1].dead) {
    let i = ticks.length - 1;
    while (i > 0 && ticks[i - 1].dead) i--;
    deathTick = ticks[i];
  }

  const adoptionOf = (j) => ticks.find((t) => t.t >= j.t) ?? null;

  const decisions = judgements.map((j, i) => {
    const adopt = adoptionOf(j);
    const win = adopt
      ? ticks.filter((t) => !t.dead && t.me && t.t >= adopt.t && t.t <= adopt.t + windowMs)
      : [];

    // --- damage taken by us over the window
    let dmgTaken = 0;
    let prevHp = adopt?.me?.hp ?? null;
    for (const t of win) {
      if (prevHp !== null && t.me.hp < prevHp) dmgTaken += prevHp - t.me.hp;
      prevHp = t.me.hp;
    }

    // --- damage dealt to each threat over the window
    const threatHp = new Map();
    let dmgDealt = 0;
    const dealtBy = new Map();
    for (const t of win) {
      for (const th of t.threats ?? []) {
        const prev = threatHp.get(th.slot);
        if (prev !== undefined && th.hp < prev) {
          const drop = prev - th.hp;
          dmgDealt += drop;
          dealtBy.set(th.slot, (dealtBy.get(th.slot) || 0) + drop);
        }
        threatHp.set(th.slot, th.hp);
      }
    }

    // --- which layer actually held the keyboard in the window
    const sourceCounts = {};
    for (const t of win) sourceCounts[t.source ?? 'idle'] = (sourceCounts[t.source ?? 'idle'] || 0) + 1;
    const reflexTicks = sourceCounts.reflex ?? 0;

    const answer = j.answers?.action ?? null;
    const choice = answer?.choice ?? j.action ?? null;
    const confidence = answer?.confidence ?? null;
    const committed = j.answers?.commit?.noul ?? null;
    const action = resolveAction(choice, profile);
    const gapAtAdoption = adopt ? nearestGap(adopt) : Infinity;

    const flags = [];
    const add = (id, labelText, tone) => flags.push({ id, label: labelText, tone });

    // The heuristic policy never calls the API, so an absent `answers` is normal
    // for it — only a network-backed policy can actually miss a decision.
    const miss = !j.answers && j.source !== 'heuristic';
    if (miss) add('miss', 'no answer (deadline)', 'red');
    if (j.latencyMs >= 1200) add('slow', `slow ${j.latencyMs}ms`, 'amber');
    if (reflexTicks > 0 && j.answers) add('reflex', `reflex overruled ${reflexTicks} ticks`, 'amber');
    if (action.attack && gapAtAdoption > action.reach + REACH_SLACK) {
      add('whiff', action.ranged ? 'attack from range' : 'out of reach', 'amber');
    }
    if (dmgTaken > 0) add('hurt', `took ${dmgTaken}`, dmgTaken >= 60 ? 'red' : 'amber');
    if (confidence !== null && confidence >= 0.6 && dmgTaken >= 40) add('conf-bad', 'confident, still hurt', 'red');
    if (confidence !== null && confidence < 0.4) add('low-conf', 'low confidence', 'amber');
    if (win.some((t) => t.dead)) add('death', 'died in this window', 'red');
    if (action.attack && dmgDealt === 0 && !flags.some((f) => f.id === 'whiff')) {
      add('no-hit', 'attack dealt no damage', 'amber');
    }

    return {
      index: i + 1,
      tick: j.tick,
      timeMs: j.t,
      latencyMs: j.latencyMs ?? null,
      source: j.source ?? null,
      state: j.state ?? null,
      criteria: j.criteria?.action ?? null,
      choice,
      confidence,
      probabilities: answer?.probabilities ?? null,
      commit: committed,
      target: j.answers?.target?.choice ?? null,
      miss,
      adoptionTick: adopt?.tick ?? null,
      gapAtAdoption: Number.isFinite(gapAtAdoption) ? Math.round(gapAtAdoption) : null,
      actionKind: action,
      outcome: {
        windowTicks: win.length,
        dmgTaken,
        dmgDealt,
        dealtBy: [...dealtBy.entries()].map(([slot, dmg]) => ({ slot, dmg })),
        hpStart: adopt?.me?.hp ?? null,
        hpEnd: win.length ? win[win.length - 1].me.hp : null,
        sources: sourceCounts,
        actualAction: win[0]?.action ?? null,
      },
      flags,
    };
  });

  // --- run-level roll-ups
  const sourceShare = {};
  for (const t of live) sourceShare[t.source ?? 'idle'] = (sourceShare[t.source ?? 'idle'] || 0) + 1;

  const flagCounts = {};
  for (const d of decisions) for (const f of d.flags) flagCounts[f.id] = (flagCounts[f.id] || 0) + 1;

  const hpSeries = ticks.filter((t) => !t.dead && t.me).map((t) => ({ t: t.t, hp: t.me.hp }));

  return {
    dir, manifest, profile,
    run: {
      id: manifest.id ?? runDir,
      label: manifest.label ?? null,
      policy: manifest.policy ?? 'unknown',
      character: manifest.character ?? '?',
      archetype: manifest.archetype ?? profile?.archetype ?? '?',
      hz: manifest.hz ?? null,
      seconds: manifest.seconds ?? null,
      durationMs: manifest.durationMs ?? null,
      ticks: ticks.length,
      decisions: decisions.length,
      misses: decisions.filter((d) => d.miss).length,
      reflexShare: live.length ? ((sourceShare.reflex ?? 0) / live.length) * 100 : 0,
      sourceShare,
      startHp, endHp,
      deathSec: deathTick ? deathTick.t / 1000 : null,
      hpSeries,
      flagCounts,
    },
    decisions,
  };
}

// ---------------------------------------------------------------- rendering

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n) => `${Math.round(n * 100)}%`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hpTimeline(run, decisions) {
  const W = 1000, H = 170, pad = 24;
  const series = run.hpSeries;
  if (!series.length) return '<p class="muted">no tick data</p>';
  const tMax = series[series.length - 1].t || 1;
  const x = (t) => pad + (t / tMax) * (W - pad * 2);
  const y = (hp) => pad + (1 - clamp(hp / 500, 0, 1)) * (H - pad * 2);

  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.hp).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series[series.length - 1].t).toFixed(1)},${H - pad} L${x(series[0].t).toFixed(1)},${H - pad} Z`;

  const dots = decisions.map((d) => {
    const tone = d.flags.some((f) => f.tone === 'red') ? '#e5484d'
      : d.flags.some((f) => f.tone === 'amber') ? '#f5a524' : '#5a77d8';
    const r = d.miss ? 4.5 : 3.5;
    return `<circle cx="${x(d.timeMs).toFixed(1)}" cy="${y(d.outcome.hpStart ?? 0).toFixed(1)}" r="${r}" fill="${d.miss ? 'none' : tone}" stroke="${tone}" stroke-width="1.5"><title>#${d.index} ${esc(d.choice ?? 'miss')} @ ${secs(d.timeMs)}</title></circle>`;
  }).join('');

  const deathMark = run.deathSec !== null
    ? `<line x1="${x(run.deathSec * 1000).toFixed(1)}" y1="${pad}" x2="${x(run.deathSec * 1000).toFixed(1)}" y2="${H - pad}" stroke="#e5484d" stroke-dasharray="3 3"/>`
    : '';

  const grid = [0, 125, 250, 375, 500].map((hp) => `<line x1="${pad}" y1="${y(hp).toFixed(1)}" x2="${W - pad}" y2="${y(hp).toFixed(1)}" stroke="#252a34" stroke-width="1"/>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="timeline" role="img" aria-label="HP over time with decision markers">
    ${grid}${deathMark}
    <path d="${area}" fill="rgba(90,119,216,0.15)"/>
    <path d="${line}" fill="none" stroke="#5a77d8" stroke-width="2"/>
    ${dots}
  </svg>`;
}

function probabilityBars(probs, chosen) {
  if (!probs) return '';
  const rows = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return `<div class="probs">${rows.map(([k, v]) => `
    <div class="prob ${k === chosen ? 'prob-chosen' : ''}">
      <span class="prob-name">${esc(k)}</span>
      <span class="prob-bar"><i style="width:${Math.round(v * 100)}%"></i></span>
      <span class="prob-val">${v.toFixed(2)}</span>
    </div>`).join('')}</div>`;
}

function situation(state) {
  if (!state) return '<span class="muted">state not recorded (heuristic policy)</span>';
  const me = state.me ?? {};
  const threats = (state.threats ?? []).map((t) =>
    `${esc(t.id)} ${esc(t.distance)} ${esc(t.side)} ${esc(t.doing)} hp:${esc(t.hp)}`).join(' · ');
  return `<span class="me">${esc(me.character)} ${esc(me.hp)} hp/${esc(me.mp)} mp`
    + `${me.holding && me.holding !== 'none' ? ` · holding ${esc(me.holding)}` : ''}`
    + ` · ${esc(me.stance)} · facing ${esc(me.facing)}</span>`
    + (threats ? `<br><span class="muted">threats: ${threats}</span>` : '');
}

function decisionCard(d) {
  const flagHtml = d.flags.map((f) => `<span class="flag flag-${f.tone}">${esc(f.label)}</span>`).join('');
  const conf = d.confidence !== null ? `<span class="conf" title="confidence">conf ${d.confidence.toFixed(2)}</span>` : '';
  const options = d.criteria ? Object.keys(d.criteria) : [];
  const chosenDesc = d.criteria?.[d.choice];

  const chips = options.map((o) =>
    `<details class="opt ${o === d.choice ? 'opt-chosen' : ''}"><summary>${esc(o)}</summary><p>${esc(d.criteria[o])}</p></details>`
  ).join('');

  const o = d.outcome;
  return `<article class="card ${d.flags.some((f) => f.tone === 'red') ? 'card-red' : ''}" id="d${d.index}">
    <header>
      <span class="idx">#${d.index}</span>
      <span class="time">${secs(d.timeMs)}</span>
      <span class="choice">${esc(d.choice ?? (d.miss ? 'no answer' : '—'))}</span>
      ${conf}${d.commit !== null ? `<span class="commit" title="commit noul">commit ${d.commit}</span>` : ''}
      ${d.latencyMs !== null ? `<span class="lat">${d.latencyMs}ms</span>` : ''}
      <span class="src src-${esc(d.source)}">${esc(d.source)}</span>
      ${flagHtml}
    </header>
    <div class="card-body">
      <div class="col left">
        <p class="sit">${situation(d.state)}</p>
        <p class="muted small">offered ${options.length} options · chosen: ${d.choice ? `<b>${esc(d.choice)}</b>` : '—'}`
        + `${d.actionKind?.attack ? ` · reach ${d.actionKind.ranged ? 'any' : d.actionKind.reach} vs gap ${d.gapAtAdoption ?? '?'}` : ''}</p>
        ${chosenDesc ? `<p class="chosen-desc">${esc(chosenDesc)}</p>` : ''}
        ${chips}
      </div>
      <div class="col right">
        ${probabilityBars(d.probabilities, d.choice)}
        <div class="outcome">
          <div class="kv"><span>hp</span><b>${o.hpStart ?? '?'} → ${o.hpEnd ?? '?'}</b></div>
          <div class="kv"><span>damage taken</span><b class="${o.dmgTaken ? 'bad' : ''}">${o.dmgTaken}</b></div>
          <div class="kv"><span>damage dealt</span><b class="${o.dmgDealt ? 'good' : ''}">${o.dmgDealt}</b></div>
          <div class="kv"><span>actual action</span><b>${esc(o.actualAction ?? '—')}</b></div>
          <div class="kv"><span>sources</span><b>${Object.entries(o.sources).map(([k, v]) => `${esc(k)}×${v}`).join(' ') || '—'}</b></div>
        </div>
      </div>
    </div>
  </article>`;
}

function renderHtml(b) {
  const run = b.run;
  const kpi = (label, value, sub = '') =>
    `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;

  const flagsSummary = Object.entries(run.flagCounts).sort((a, b2) => b2[1] - a[1])
    .map(([k, v]) => `<span class="flag-sum">${esc(k)} <b>${v}</b></span>`).join('') || '<span class="muted">none</span>';

  const suspects = b.decisions.filter((d) => d.flags.some((f) => f.tone === 'red'))
    .map((d) => `<a href="#d${d.index}">#${d.index} ${esc(d.choice ?? 'miss')} — ${esc(d.flags.map((f) => f.label).join(', '))}</a>`).join('') || '<span class="muted">none</span>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Breakdown — ${esc(run.id)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0e1016; color:#dfe3ea; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .wrap { max-width:1180px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:#8b93a5; margin:36px 0 12px; border-bottom:1px solid #1c2029; padding-bottom:6px; }
  .sub { color:#8b93a5; margin-bottom:24px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; }
  .kpi { background:#141822; border:1px solid #1e2430; border-radius:10px; padding:12px 14px; }
  .kpi-v { font-size:22px; font-weight:700; }
  .kpi-l { color:#8b93a5; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
  .kpi-s { color:#6b7280; font-size:11px; margin-top:4px; }
  .timeline { width:100%; height:auto; background:#10141c; border:1px solid #1e2430; border-radius:10px; }
  .flags-summary { display:flex; flex-wrap:wrap; gap:8px; }
  .flag-sum { background:#141822; border:1px solid #1e2430; border-radius:999px; padding:4px 10px; color:#b6bdcb; }
  .flag-sum b { color:#fff; }
  .suspects { display:flex; flex-direction:column; gap:4px; }
  .suspects a { color:#f5a524; text-decoration:none; }
  article.card { background:#141822; border:1px solid #1e2430; border-radius:12px; margin:12px 0; overflow:hidden; }
  article.card-red { border-color:#5a2a2d; }
  article.card header { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px 14px; background:#171c27; border-bottom:1px solid #1e2430; }
  .idx { color:#6b7280; }
  .time { color:#8b93a5; }
  .choice { font-weight:700; color:#fff; }
  .conf, .commit, .lat { color:#8b93a5; font-size:12px; }
  .src { margin-left:auto; font-size:11px; padding:2px 8px; border-radius:999px; background:#202634; color:#b6bdcb; }
  .src-jev { background:#1f2b4d; color:#9db4ff; }
  .src-reflex { background:#4a3410; color:#f5c66b; }
  .src-heuristic { background:#1c3326; color:#7de0a5; }
  .flag { font-size:11px; padding:2px 8px; border-radius:999px; }
  .flag-red { background:#3a1d1f; color:#ff8a8f; }
  .flag-amber { background:#3a2f14; color:#f5c66b; }
  .card-body { display:grid; grid-template-columns:1.6fr 1fr; gap:16px; padding:14px; }
  @media (max-width:820px){ .card-body { grid-template-columns:1fr; } }
  .sit { margin:0 0 6px; }
  .me { color:#cdd4e0; }
  .muted { color:#6b7280; }
  .small { font-size:12px; }
  .chosen-desc { color:#aeb6c4; border-left:2px solid #5a77d8; padding-left:10px; margin:10px 0; }
  details.opt { border:1px solid #1e2430; border-radius:7px; margin:3px 0; background:#10141c; }
  details.opt summary { cursor:pointer; padding:5px 9px; color:#b6bdcb; }
  details.opt.opt-chosen summary { color:#9db4ff; font-weight:700; }
  details.opt p { margin:0; padding:8px 10px; color:#8b93a5; border-top:1px solid #1e2430; }
  .probs { display:flex; flex-direction:column; gap:3px; }
  .prob { display:grid; grid-template-columns:130px 1fr 42px; align-items:center; gap:8px; font-size:12px; }
  .prob-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9aa3b2; }
  .prob-chosen .prob-name { color:#9db4ff; font-weight:700; }
  .prob-bar { background:#1e2430; border-radius:4px; height:7px; overflow:hidden; }
  .prob-bar i { display:block; height:100%; background:#3d4a6b; }
  .prob-chosen .prob-bar i { background:#5a77d8; }
  .prob-val { text-align:right; color:#8b93a5; }
  .outcome { margin-top:14px; border-top:1px solid #1e2430; padding-top:10px; display:flex; flex-direction:column; gap:4px; }
  .kv { display:flex; justify-content:space-between; gap:12px; font-size:12px; }
  .kv span { color:#8b93a5; }
  .bad { color:#ff8a8f; } .good { color:#7de0a5; }
</style></head>
<body><div class="wrap">
  <h1>Match breakdown — ${esc(run.id)}</h1>
  <div class="sub">${esc(run.label ?? '')} · ${esc(run.policy)} policy · ${esc(run.character)} (${esc(run.archetype)}) · ${run.seconds ?? '?'}s @ ${run.hz ?? '?'}Hz · ${run.decisions} decisions</div>

  <div class="kpis">
    ${kpi('decisions', run.decisions)}
    ${kpi('misses', run.misses, run.decisions ? pct(run.misses / run.decisions) : '')}
    ${kpi('reflex share', `${run.reflexShare.toFixed(1)}%`, 'of live ticks')}
    ${kpi('ticks', run.ticks)}
    ${kpi('hp start→end', `${run.startHp ?? '?'}→${run.endHp ?? '?'}`)}
    ${kpi('death', run.deathSec !== null ? secs(run.deathSec * 1000) : 'survived')}
  </div>

  <h2>HP over time</h2>
  ${hpTimeline(run, b.decisions)}
  <p class="muted small">Blue = decision, amber = flagged, red = problem, hollow = no answer. Dashed red = death.</p>

  <h2>Flags</h2>
  <div class="flags-summary">${flagsSummary}</div>

  <h2>Worth your eyes first</h2>
  <div class="suspects">${suspects}</div>

  <h2>Every decision</h2>
  ${b.decisions.map(decisionCard).join('')}
</div></body></html>`;
}

// ---------------------------------------------------------------- cli

const runDir = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!runDir) {
  console.log('Usage: node scripts/breakdown.mjs <runDir> [--window ms] [--out path] [--no-html]');
  process.exit(1);
}

const b = analyze(runDir);
const out = arg('out', join(resolve(process.cwd(), runDir), 'breakdown.html'));
if (!has('no-html')) {
  writeFileSync(out, renderHtml(b));
}

const r = b.run;
console.log(`Match breakdown — ${r.id} (${r.policy}, ${r.character}, ${r.decisions} decisions)`);
console.log(`  misses ${r.misses}   reflex share ${r.reflexShare.toFixed(1)}%   hp ${r.startHp}→${r.endHp}`
  + `${r.deathSec !== null ? `   died @ ${secs(r.deathSec * 1000)}` : ''}`);
const flags = Object.entries(r.flagCounts).sort((a, c) => c[1] - a[1]);
if (flags.length) console.log(`  flags: ${flags.map(([k, v]) => `${k} ${v}`).join(', ')}`);
process.stdout.write(has('no-html') ? '' : `\n  html: ${out}\n`);
