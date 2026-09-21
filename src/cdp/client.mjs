/**
 * Minimal Chrome DevTools Protocol client for the shipped game.
 *
 * Node 24 has a global WebSocket, so this has no dependencies. The Debugger
 * domain is never enabled — the game's obfuscator has debug protection that
 * only triggers when it is, and everything needed is reachable through
 * Runtime alone (see docs/00-findings.md).
 */
import { setTimeout as sleep } from 'node:timers/promises';

export async function connect({ port = 9222, waitMs = 30000, quiet = true, keepAwake = true } = {}) {
  const page = await waitForPage(port, waitMs);
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    for (const fn of listeners) fn(msg);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`CDP socket failed: ${e.message ?? e.type}`));
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** Evaluate and return a plain JS value. Throws on a page-side exception. */
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(`page threw: ${ex.exception?.description ?? ex.text}`);
    return r.result?.result?.value;
  }

  /** Evaluate and keep the remote handle, for objects that don't serialize. */
  async function evalHandle(expression) {
    const r = await send('Runtime.evaluate', { expression });
    if (r.result?.exceptionDetails) return null;
    return r.result?.result ?? null;
  }

  const getProps = async (objectId, ownProperties = true) =>
    (await send('Runtime.getProperties', { objectId, ownProperties })).result ?? {};

  /**
   * The bundle's top-level script scope, reached through any function the page
   * defined. Nothing lives on `window`, so this is the only route to game state
   * without enabling the Debugger domain.
   *
   * Which global function exposes the full scope changes with load order, so
   * candidates are probed and the widest `Script` scope wins.
   */
  async function scriptScope(candidates = SCOPE_CANDIDATES) {
    let best = null;
    for (const name of candidates) {
      const fn = await evalHandle(name);
      if (!fn?.objectId) continue;
      const { internalProperties = [] } = await getProps(fn.objectId, false);
      const scopes = internalProperties.find((p) => p.name === '[[Scopes]]');
      if (!scopes?.value?.objectId) continue;
      const list = (await getProps(scopes.value.objectId)).result ?? [];
      for (const s of list) {
        if (s.value?.description !== 'Script') continue;
        const count = ((await getProps(s.value.objectId)).result ?? []).length;
        if (!best || count > best.count) best = { via: name, objectId: s.value.objectId, count };
      }
    }
    if (!best) throw new Error('no script scope found on any candidate function');
    return best;
  }

  /** Live variables of the script scope, as CDP property descriptors. */
  async function scopeVars() {
    const scope = await scriptScope();
    return { ...scope, vars: (await getProps(scope.objectId)).result ?? [] };
  }

  /** Synthetic key that the game sees as isTrusted (verified in Phase 0). */
  async function key(code, { down = true, up = true, holdMs = 150 } = {}) {
    const base = { code, key: KEY_OF[code] ?? code, windowsVirtualKeyCode: VK_OF[code] ?? 0 };
    if (down) await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    if (down && up) await sleep(holdMs);
    if (up) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /**
   * Chromium stops the frame loop for a window that is not on screen, which
   * stops the game with it: reads come back frozen and a screenshot never
   * returns. Emulated focus restarts it. The window still has to be visible
   * for full speed — occluded, it is throttled to a few frames a second.
   */
  if (keepAwake) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.setWebLifecycleState', { state: 'active' });
  }

  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const close = () => ws.close();

  if (!quiet) console.error(`cdp: attached to ${page.title || page.url}`);
  return { send, evaluate, evalHandle, getProps, scriptScope, scopeVars, key, on, close, page };
}

async function waitForPage(port, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
      lastErr = new Error('no page target yet');
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`no CDP page on port ${port} after ${waitMs}ms (${lastErr?.message})`);
}

/**
 * Global functions worth probing for the script scope. `onerror` and friends are
 * assigned by the bundle itself, so they carry the same closure as the game code.
 */
export const SCOPE_CANDIDATES = ['onerror', 'onresize', 'onunhandledrejection', 'globalQuitGame', 'resizeApp'];

/** Only the codes the harness actually sends. */
export const KEY_OF = {
  Enter: 'Enter', Escape: 'Escape', Space: ' ', Tab: 'Tab', Backquote: '`', Quote: "'",
  ShiftRight: 'Shift', Period: '.', Comma: ',',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
  F1: 'F1', F2: 'F2',
  F13: 'F13', F14: 'F14', F15: 'F15', F16: 'F16', F17: 'F17', F18: 'F18', F19: 'F19', F20: 'F20', F21: 'F21', F22: 'F22', F23: 'F23', F24: 'F24',
  Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
  Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
  NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
  NumpadDecimal: '.', NumpadEnter: 'Enter',
};
export const VK_OF = {
  Enter: 13, Escape: 27, Space: 32, Tab: 9, ShiftRight: 16, Comma: 188, Period: 190,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76,
  F1: 112, F2: 113,
  F13: 124, F14: 125, F15: 126, F16: 127, F17: 128, F18: 129, F19: 130, F20: 131, F21: 132, F22: 133, F23: 134, F24: 135,
  Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100,
  Numpad5: 101, Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110,
  NumpadDivide: 111, NumpadEnter: 13,
};
