/**
 * Launches the game with the CDP port open, or attaches to one already running.
 *
 *   node scripts/launch-game.mjs [--port 9222] [--attach]
 *
 * Leaves the game running after exit; the harness scripts attach separately.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const GAME_EXE = 'C:/LF2-Remastered/LF2-Remastered(The Game)/lf2.exe';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

export async function isUp(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.some((t) => t.type === 'page');
  } catch {
    return false;
  }
}

export async function launch({ port = 9222, exe = GAME_EXE, waitMs = 45000 } = {}) {
  if (await isUp(port)) return { started: false, port };
  if (!existsSync(exe)) throw new Error(`game not found at ${exe}`);

  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isUp(port)) return { started: true, port, pid: child.pid };
    await sleep(500);
  }
  throw new Error(`game started (pid ${child.pid}) but no CDP page on ${port} after ${waitMs}ms`);
}

if (process.argv[1]?.endsWith('launch-game.mjs')) {
  const port = Number(arg('port', 9222));
  if (process.argv.includes('--attach')) {
    console.log(await isUp(port) ? `game already listening on ${port}` : `nothing on ${port}`);
  } else {
    const r = await launch({ port });
    console.log(r.started ? `launched, pid ${r.pid}, CDP on ${r.port}` : `already running on ${r.port}`);
  }
}
