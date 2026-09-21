/**
 * Runs inside the game page. Injected by src/executor/overlay.mjs, never
 * imported by the harness — it is a source file only so the CSS and markup can
 * be edited like code instead of inside a template string.
 *
 * It borrows the game's own palette, the deep blue rgb(16,32,108) panel and the
 * rgb(90,119,216) border it uses everywhere, so the panel belongs on screen.
 * Then it breaks from it deliberately: an amber edge, an amber title and a
 * monospace readout. The game uses neither anywhere, so there is no mistaking
 * this for the game's own HUD.
 *
 * Nothing here can affect the fight. No key handlers, no pointer events, and
 * every update is a one-way push from the executor.
 */

(() => {
  const ID = 'jev-overlay';
  document.getElementById(ID)?.remove();
  document.getElementById(ID + '-style')?.remove();

  const style = document.createElement('style');
  style.id = ID + '-style';
  style.textContent = `
    #jev-overlay {
      position: fixed; left: 1.2vmin; bottom: 1.2vmin; z-index: 99999;
      width: 38vmin; min-width: 330px; pointer-events: none;
      font-family: Arial, Helvetica, sans-serif;
      color: #fff;
      background: rgba(16, 32, 108, 0.93);
      border: 0.28vmin solid rgb(90, 119, 216);
      border-left: 0.75vmin solid #f0a830;
      border-radius: 1.1vmin;
      box-shadow: 0 0 2.4vmin rgba(0, 0, 0, 0.7);
      overflow: hidden;
      transition: opacity .25s;
    }
    #jev-overlay.dead { opacity: .4; }
    #jev-overlay .jv-head {
      display: flex; justify-content: space-between; align-items: baseline;
      padding: .7vmin 1vmin .5vmin;
      border-bottom: .14vmin solid rgba(90, 119, 216, .5);
    }
    #jev-overlay .jv-title {
      color: #f0a830; font-weight: bold; font-size: 1.75vmin; letter-spacing: .16vmin;
    }
    #jev-overlay .jv-sub {
      color: rgb(126, 150, 230); font-size: 1.35vmin;
      font-family: Consolas, "Courier New", monospace;
      max-width: 20vmin; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    #jev-overlay .jv-body { padding: .8vmin 1vmin 1vmin; }
    #jev-overlay .jv-action {
      display: flex; align-items: center; gap: .7vmin;
      margin-bottom: .6vmin; border-radius: .4vmin;
    }
    #jev-overlay .jv-now {
      font-family: Consolas, "Courier New", monospace;
      font-size: 2.5vmin; font-weight: bold; color: #fff;
      text-shadow: 0 0 .9vmin rgba(240, 168, 48, .5);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #jev-overlay .jv-badge {
      margin-left: auto; padding: .18vmin .6vmin; border-radius: .4vmin;
      font-size: 1.25vmin; font-weight: bold; letter-spacing: .12vmin;
      background: #f0a830; color: rgb(16, 32, 108);
    }
    #jev-overlay .jv-badge.reflex { background: #e2604a; color: #fff; }
    #jev-overlay .jv-badge.heuristic { background: rgb(90, 119, 216); color: #fff; }
    #jev-overlay .jv-row {
      display: grid; grid-template-columns: 1fr auto; gap: .5vmin;
      align-items: center; margin: .14vmin 0;
      font-family: Consolas, "Courier New", monospace;
      font-size: 1.45vmin; color: rgb(190, 208, 255);
    }
    #jev-overlay .jv-row.top { color: #fff; }
    /* Everything Jev could have done is on the panel; the ones it all but ruled
       out are dimmed rather than hidden, so the list reads as a shortlist
       without pretending the rejected options were never offered. */
    #jev-overlay .jv-row.cold { opacity: .45; }
    #jev-overlay .jv-count {
      font-family: Consolas, "Courier New", monospace; font-size: 1.2vmin;
      color: rgb(126, 150, 230); margin: .45vmin 0 .25vmin;
      display: flex; justify-content: space-between;
    }
    #jev-overlay .jv-name {
      position: relative; padding: .12vmin .45vmin; border-radius: .3vmin;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; isolation: isolate;
    }
    #jev-overlay .jv-fill {
      position: absolute; left: 0; top: 0; bottom: 0; width: 0; z-index: -1;
      background: rgba(90, 119, 216, .5); transition: width .18s;
    }
    #jev-overlay .jv-row.top .jv-fill { background: rgba(240, 168, 48, .42); }
    #jev-overlay .jv-bars {
      display: grid; grid-template-columns: auto 1fr auto; gap: .45vmin .7vmin;
      align-items: center; margin-top: .7vmin;
      font-family: Consolas, "Courier New", monospace; font-size: 1.35vmin;
      color: rgb(190, 208, 255);
    }
    #jev-overlay .jv-track {
      position: relative; height: 1.15vmin; border-radius: .48vmin;
      background: rgba(0, 0, 0, .5); overflow: hidden;
    }
    #jev-overlay .jv-track > div { position: absolute; left: 0; top: 0; bottom: 0; width: 0; }
    #jev-overlay .jv-dark { background: rgba(217, 79, 79, .34); }
    #jev-overlay .jv-hp { background: #d94f4f; }
    #jev-overlay .jv-mp { background: rgb(90, 119, 216); }
    #jev-overlay .jv-meta {
      display: flex; gap: 1vmin; margin-top: .7vmin; padding-top: .5vmin;
      border-top: .14vmin solid rgba(90, 119, 216, .35);
      font-family: Consolas, "Courier New", monospace;
      font-size: 1.2vmin; color: rgb(126, 150, 230);
      white-space: nowrap;
    }
    #jev-overlay .jv-meta > span { overflow: hidden; text-overflow: ellipsis; }
    #jev-overlay .jv-flash { animation: jv-flash .5s ease-out; }
    @keyframes jv-flash {
      from { background: rgba(240, 168, 48, .38); }
      to { background: transparent; }
    }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = ID;
  el.innerHTML = `
    <div class="jv-head">
      <span class="jv-title">JEV &middot; SYSTEM ONE</span>
      <span class="jv-sub" data-sub>waiting</span>
    </div>
    <div class="jv-body">
      <div class="jv-action">
        <span class="jv-now" data-now>&mdash;</span>
        <span class="jv-badge" data-badge>IDLE</span>
      </div>
      <div class="jv-count" data-count></div>
      <div data-options></div>
      <div class="jv-bars">
        <span>HP</span>
        <div class="jv-track"><div class="jv-dark" data-dark></div><div class="jv-hp" data-hp></div></div>
        <span data-hpn>&mdash;</span>
        <span>MP</span>
        <div class="jv-track"><div class="jv-mp" data-mp></div></div>
        <span data-mpn>&mdash;</span>
      </div>
      <div class="jv-meta">
        <span data-near>&mdash;</span>
        <span style="margin-left:auto" data-counts></span>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  const q = (name) => el.querySelector('[data-' + name + ']');
  const pct = (n, d) => (d ? Math.max(0, Math.min(1, n / d)) * 100 : 0) + '%';
  let lastAction = null;

  window.__jev = (d) => {
    q('now').textContent = d.action || '—';

    const badge = q('badge');
    badge.textContent = (d.source || 'idle').toUpperCase();
    badge.className = 'jv-badge'
      + (d.source === 'reflex' ? ' reflex' : d.source === 'jev' ? '' : ' heuristic');

    q('sub').textContent = d.reflex ? d.reflex
      : d.latencyMs != null
        ? d.latencyMs + ' ms · ' + (d.confidence != null ? 'conf ' + d.confidence.toFixed(2) : 'no answer')
        : (d.policy || '');

    // The probabilities are the point of the panel: what else was considered,
    // and by how much it lost. All of them are drawn — a truncated list looks
    // like a short menu, and then you cannot tell a move Jev rejected from one
    // it was never offered.
    const probs = Object.entries(d.probabilities || {}).sort((a, b) => b[1] - a[1]);
    const offered = (d.options && d.options.length) || probs.length;
    q('count').innerHTML = probs.length
      ? '<span>' + offered + ' options offered</span><span>'
        + (d.commit === true ? 'commit' : d.commit === false ? 'hold' : '') + '</span>'
      : '<span>' + offered + ' options offered</span><span></span>';
    q('options').innerHTML = probs.map(([name, p], i) =>
      '<div class="jv-row' + (i === 0 ? ' top' : '') + (p < 0.05 ? ' cold' : '') + '">'
      + '<span class="jv-name"><span class="jv-fill" style="width:' + Math.round(p * 100) + '%"></span>'
      + name.replace(/_/g, ' ') + '</span>'
      + '<span>' + Math.round(p * 100) + '%</span></div>').join('')
      // Before the first answer there are no probabilities, but the options are
      // already chosen; listing them shows what Jev is about to pick between.
      || (d.options || []).map((name) =>
        '<div class="jv-row cold"><span class="jv-name">' + name.replace(/_/g, ' ')
        + '</span><span>&middot;</span></div>').join('');

    q('hp').style.width = pct(d.hp, d.hpMax);
    q('dark').style.width = pct(d.darkHp != null ? d.darkHp : d.hp, d.hpMax);
    q('hpn').textContent = Math.round(d.hp || 0);
    q('mp').style.width = pct(d.mp, d.mpMax || 500);
    q('mpn').textContent = Math.round(d.mp || 0);

    q('near').textContent = (d.nearest
      ? d.nearest.distance + ' · ' + d.nearest.name + ' · ' + d.nearest.doing
        // ⚡ is a window that cannot answer, ✳ one that only looks like it.
        + (d.nearest.vulnerable ? (d.nearest.helpless ? ' ⚡' : ' ✳') : '')
      : 'no enemy')
      // The thrown weapon is the damage that arrives with no swing to see.
      + (d.threat ? '   ✈ ' + d.threat.name + ' ' + d.threat.distance : '');
    q('counts').textContent = d.counts
      ? d.counts.decisions + ' dec · ' + d.counts.misses + ' miss · ' + d.counts.stale + ' stale'
      : '';

    el.classList.toggle('dead', !!d.dead);

    if (d.action !== lastAction) {
      lastAction = d.action;
      const row = el.querySelector('.jv-action');
      row.classList.remove('jv-flash');
      void row.offsetWidth;
      row.classList.add('jv-flash');
    }
  };

  return 'ok';
})()
