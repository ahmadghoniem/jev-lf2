/**
 * Parser for Little Fighter 2 Remastered data files (_res_data/*.txt).
 *
 * The game ships its complete frame data in plain text: hitboxes, damage, timing,
 * and the input -> frame transitions that make up every move. Everything the
 * reflex layer and the move repertoire need comes from here, so none of it has to
 * be learned by watching the screen.
 *
 * See docs/04-lf2-data-format.md for the format itself.
 */

/** Tags that appear inside a frame block. `bp` must precede `b` in the alternation. */
const TAG_NAMES = ['bp', 'i', 'b', 'w', 'c', 'o'];
const TAG_RE = new RegExp(`<(${TAG_NAMES.join('|')})\\s+([\\s\\S]*?)\\s*\\1>`, 'g');
const FRAME_RE = /<f\s+(-?\d+)\s+(\S*)([\s\S]*?)^\s*f>/gm;

/** `pic 0 state 1000 next 1 sound mp3/041` -> { pic: 0, state: 1000, ... } */
function parseTokens(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const raw = tokens[i + 1];
    if (raw === undefined) continue;
    const num = Number(raw);
    out[key] = Number.isNaN(num) ? raw : num;
    i++;
  }
  return out;
}

function parseTags(block) {
  const tags = { itr: [], bdy: [], wpoint: [], bpoint: [], cpoint: [], opoint: [] };
  const bucket = { i: 'itr', b: 'bdy', w: 'wpoint', bp: 'bpoint', c: 'cpoint', o: 'opoint' };
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(block)) !== null) {
    tags[bucket[m[1]]].push(parseTokens(m[2]));
  }
  return tags;
}

/** Input suffixes on `hit_*` fields, in the game's own notation. */
const MOVE_INPUTS = ['a', 'd', 'j', 'Fa', 'Ua', 'Da', 'Uj'];

export function parseFrames(text) {
  const frames = new Map();
  FRAME_RE.lastIndex = 0;
  let m;
  while ((m = FRAME_RE.exec(text)) !== null) {
    const [, id, name, body] = m;
    const withoutTags = body.replace(TAG_RE, ' ');
    const fields = parseTokens(withoutTags);

    const transitions = {};
    for (const input of MOVE_INPUTS) {
      const target = fields[`hit_${input}`];
      if (typeof target === 'number') transitions[input] = target;
      delete fields[`hit_${input}`];
    }

    frames.set(Number(id), {
      id: Number(id),
      name: name === '-' ? null : name,
      ...fields,
      transitions,
      ...parseTags(body),
    });
  }
  return frames;
}

export function parseHeader(text) {
  const end = text.search(/<f\s+-?\d+\s/);
  const head = end === -1 ? text : text.slice(0, end);

  const wsl = [];
  const wslBlock = head.match(/<wsl([\s\S]*?)wsl>/);
  if (wslBlock) {
    for (const line of wslBlock[1].split('\n')) {
      if (!line.trim().startsWith('entry')) continue;
      const parts = line.trim().split(/\s+/);
      wsl.push({ entry: Number(parts[1]), attack: parts[2], ...parseTokens(parts.slice(3).join(' ')) });
    }
  }

  const fields = {};
  const sprites = [];
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('<') || t.endsWith('>') && !t.includes(' ')) continue;
    if (t.startsWith('file(')) { sprites.push(t); continue; }
    const [key, ...rest] = t.split(/\s+/);
    if (!/^[a-z_][a-z0-9_]*$/i.test(key) || rest.length === 0) continue;
    const num = Number(rest[0]);
    fields[key] = rest.length === 1 && !Number.isNaN(num) ? num : rest.join(' ');
  }
  return { ...fields, wsl, sprites };
}

export function parseDataFile(text) {
  return { header: parseHeader(text), frames: parseFrames(text) };
}
