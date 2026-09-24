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
 * The panel cannot affect the fight: no pointer events, and every update is a
 * one-way push from the executor. The one thing that talks back is the note
 * box, which only exists while the game is paused (Esc): what is typed there is
 * handed to the executor on its next update and logged against the paused tick.
 */

(() => {
  const ID = 'jev-overlay';
  document.getElementById(ID)?.remove();
  document.getElementById(ID + '-style')?.remove();
  document.getElementById('jev-subpick')?.remove();
  window.__jevNoteCleanup?.();

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
    #jev-note {
      position: fixed; left: 50%; top: 6vmin; transform: translateX(-50%);
      z-index: 100000; width: 60vmin; min-width: 420px; display: none;
      font-family: Arial, Helvetica, sans-serif; color: #fff;
      background: rgba(16, 32, 108, 0.96);
      border: 0.28vmin solid rgb(90, 119, 216);
      border-top: 0.75vmin solid #f0a830;
      border-radius: 1.1vmin; box-shadow: 0 0 2.4vmin rgba(0, 0, 0, 0.7);
      padding: 1vmin 1.2vmin;
    }
    #jev-note.open { display: block; }
    #jev-note .jn-head {
      display: flex; justify-content: space-between; align-items: baseline;
      color: #f0a830; font-weight: bold; font-size: 1.75vmin; letter-spacing: .16vmin;
      margin-bottom: .7vmin;
    }
    #jev-note .jn-hint { color: rgb(126, 150, 230); font-weight: normal; letter-spacing: 0; font-size: 1.3vmin; }
    #jev-note textarea {
      width: 100%; box-sizing: border-box; height: 9vmin; resize: none;
      font-family: Consolas, "Courier New", monospace; font-size: 1.8vmin;
      color: #fff; background: rgba(0, 0, 0, .45);
      border: .14vmin solid rgb(90, 119, 216); border-radius: .5vmin; padding: .6vmin;
      outline: none;
    }
    #jev-note textarea:focus { border-color: #f0a830; }
    #jev-note .jn-saved {
      margin-top: .6vmin; font-family: Consolas, "Courier New", monospace;
      font-size: 1.35vmin; color: rgb(190, 208, 255);
    }
    /* A kind of option (every special, every melee attack) is one row in the
       list; the follow-up that picked within it opens beside that row. */
    #jev-overlay .jv-row .jv-more { color: #f0a830; margin-left: .4vmin; }
    #jev-subpick {
      position: fixed; z-index: 99999; pointer-events: none; display: none;
      width: 30vmin; min-width: 260px;
      font-family: Consolas, "Courier New", monospace; font-size: 1.45vmin;
      color: rgb(190, 208, 255);
      background: rgba(16, 32, 108, 0.96);
      border: 0.28vmin solid rgb(90, 119, 216);
      border-left: 0.75vmin solid #f0a830;
      border-radius: 1.1vmin; box-shadow: 0 0 2.4vmin rgba(0, 0, 0, 0.7);
      padding: .6vmin .9vmin .8vmin;
    }
    #jev-subpick.open { display: block; }
    #jev-subpick .js-head {
      color: #f0a830; font-family: Arial, Helvetica, sans-serif; font-weight: bold;
      font-size: 1.35vmin; letter-spacing: .14vmin; margin-bottom: .45vmin;
    }
    #jev-subpick .jv-row {
      display: grid; grid-template-columns: 1fr auto; gap: .5vmin;
      align-items: center; margin: .14vmin 0;
    }
    #jev-subpick .jv-row.top { color: #fff; }
    #jev-subpick .jv-row.cold { opacity: .45; }
    #jev-subpick .jv-name {
      position: relative; padding: .12vmin .45vmin; border-radius: .3vmin;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; isolation: isolate;
    }
    #jev-subpick .jv-fill {
      position: absolute; left: 0; top: 0; bottom: 0; z-index: -1;
      background: rgba(90, 119, 216, .5);
    }
    #jev-subpick .jv-row.top .jv-fill { background: rgba(240, 168, 48, .42); }
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

  const subpick = document.createElement('div');
  subpick.id = 'jev-subpick';
  document.body.appendChild(subpick);

  // --- the note box. It follows the game's own pause flag rather than
  // guessing from Esc presses, so it can never be open while the fight runs.
  const note = document.createElement('div');
  note.id = 'jev-note';
  note.innerHTML = `
    <div class="jn-head"><span style="white-space:nowrap">NOTE FOR THIS MOMENT</span>
      <span class="jn-hint">Enter saves &middot; Shift+Enter new line &middot; Esc resumes</span></div>
    <textarea spellcheck="false" placeholder="What did you see?"></textarea>
    <div class="jn-saved" data-saved></div>
  `;
  document.body.appendChild(note);
  const box = note.querySelector('textarea');
  const savedLine = note.querySelector('[data-saved]');
  const outbox = [];
  let savedHere = 0;
  let paused = false;

  const save = () => {
    const text = box.value.trim();
    if (!text) return;
    outbox.push({ text, at: Date.now() });
    box.value = '';
    savedHere++;
    savedLine.textContent = savedHere + ' note' + (savedHere === 1 ? '' : 's') + ' saved at this moment';
  };

  const isPaused = () => {
    const g = window.__jevGameRef;
    return !!g && g.J0 === 0 && g.pause === 1;
  };
  const poll = setInterval(() => {
    const now = isPaused();
    if (now === paused) return;
    paused = now;
    if (paused) {
      savedHere = 0;
      savedLine.textContent = '';
      note.classList.add('open');
      box.focus();
    } else {
      save();
      box.blur();
      note.classList.remove('open');
    }
  }, 100);

  // The game reads keys from a bubbling listener on window, and while paused
  // some letters do things (Q, N, H, Z). A capturing listener on window runs
  // before it, so typed keys stop here and only reach the textarea. Esc goes
  // through, because Esc is what resumes the game.
  const swallow = (e) => {
    if (document.activeElement !== box) return;
    if (e.key === 'Escape') {
      if (e.type === 'keydown') { save(); box.blur(); }
      return;
    }
    if (e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    e.stopPropagation();
  };
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, swallow, true);
  window.__jevNoteCleanup = () => {
    clearInterval(poll);
    for (const type of ['keydown', 'keyup', 'keypress']) window.removeEventListener(type, swallow, true);
    note.remove();
    delete window.__jevNoteCleanup;
  };

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
    const followUps = d.followUps || {};
    const row = (name, p, i, attrs = '') =>
      '<div class="jv-row' + (i === 0 ? ' top' : '') + (p < 0.05 ? ' cold' : '') + '"' + attrs + '>'
      + '<span class="jv-name"><span class="jv-fill" style="width:' + Math.round(p * 100) + '%"></span>'
      + name.replace(/_/g, ' ') + (followUps[name] ? '<span class="jv-more">&#9656;</span>' : '') + '</span>'
      + '<span>' + Math.round(p * 100) + '%</span></div>';
    q('options').innerHTML = probs.map(([name, p], i) => row(name, p, i, ' data-kind="' + name + '"')).join('')
      // Before the first answer there are no probabilities, but the options are
      // already chosen; listing them shows what Jev is about to pick between.
      || (d.options || []).map((name) =>
        '<div class="jv-row cold"><span class="jv-name">' + name.replace(/_/g, ' ')
        + '</span><span>&middot;</span></div>').join('');

    // The sub-menu: when the chosen row is a kind, the follow-up that picked
    // within it, beside that row, with the member actually played on top.
    const chosen = probs.length ? probs[0][0] : null;
    const sub = chosen && followUps[chosen];
    if (sub) {
      const members = Object.entries(sub.probabilities).sort((a, b) => b[1] - a[1]);
      subpick.innerHTML = '<div class="js-head">WHICH ' + chosen.replace(/_/g, ' ').toUpperCase() + '</div>'
        + members.map(([name, p], i) => row(name, p, i)).join('');
      const anchor = el.querySelector('[data-kind="' + chosen + '"]') || el;
      const box = el.getBoundingClientRect();
      const at = anchor.getBoundingClientRect();
      subpick.style.left = (box.right + 8) + 'px';
      subpick.classList.add('open');
      // Level with the row, kept on screen.
      subpick.style.top = Math.max(8, Math.min(at.top - 6, window.innerHeight - subpick.offsetHeight - 8)) + 'px';
    } else {
      subpick.classList.remove('open');
    }

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
    subpick.style.opacity = d.dead ? '.4' : '';

    if (d.action !== lastAction) {
      lastAction = d.action;
      const row = el.querySelector('.jv-action');
      row.classList.remove('jv-flash');
      void row.offsetWidth;
      row.classList.add('jv-flash');
    }
    return { paused: isPaused(), notes: outbox.splice(0) };
  };

  return 'ok';
})()
