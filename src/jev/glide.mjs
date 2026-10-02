/**
 * Glide: Fastino's GLiNER encoders behind the Jev client, chosen with
 * `JEV_BACKEND=glide`. An encoder classifier reads one text and scores labels
 * per task. Asked with `multi_label` and `cls_threshold: 0` it scores every
 * label on its own; the pick is the highest, and `probabilities` are the
 * scores scaled to sum to 1. (Without those two keys it names only its top
 * label, which is how the first trial of 2026-10-01 ran.)
 *
 * Jev's action question offers grouped kinds (melee_attack, avoid_hit, ...)
 * with a follow-up per kind (nest.mjs). Glide scores the members directly:
 * the action task lists every member in place of its kind, and a member pick
 * is returned as the kind plus its follow-up, so the harness sees Jev's shape.
 * In the first trial the abstract kind labels were never picked: Henry never
 * blocked, rolled or punched.
 *
 * `GLIDE_MODEL` picks the model (default fastino/GLiNER-2.5-Decide).
 * `GLIDE_DESC=labels` passes option descriptions as label descriptions, which
 * gliner2.5-multi-v1 hosts and Decide refuses with a 400; the default puts
 * them in the text. Decide takes about 2000 tokens of input (4.2 characters
 * a token), multi-v1 about 4000; over the budget, descriptions are cut to
 * their first few sentences, fewer until the request fits.
 */

export const GLIDE = {
  apiKey: 'FASTINO_API_KEY',
  url: 'https://api.fastino.ai/v1/chat/completions',
};
const model = () => process.env.GLIDE_MODEL ?? 'fastino/GLiNER-2.5-Decide';
const descInLabels = () => process.env.GLIDE_DESC === 'labels';
const budgetChars = () => (model().includes('multi') ? 14000 : 7000);

const label = (name) => name.replace(/_/g, ' ');
const firstSentences = (text, n) => (n === Infinity ? text : (text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]).slice(0, n).join('').trim());

/** Each task's options, name -> description, with grouped kinds replaced by their members. */
function tasksOf(questions) {
  const followUps = Object.keys(questions).filter((k) => k.startsWith('which_'));
  const tasks = {};
  for (const [task, q] of Object.entries(questions)) {
    if (followUps.includes(task)) continue;
    if (q.type === 'noul') { tasks[task] = { q, options: { true: q.criteria.true, false: q.criteria.false } }; continue; }
    if (q.type === 'score') { tasks[task] = { q, options: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])) }; continue; }
    const options = {};
    for (const [name, text] of Object.entries(q.criteria)) {
      const members = questions[`which_${name}`]?.criteria;
      if (members) Object.assign(options, members);
      else options[name] = text;
    }
    tasks[task] = { q, options };
  }
  return tasks;
}

function build(state, tasks, n) {
  const situation = typeof state === 'string' ? state : JSON.stringify(state);
  const parts = [`Situation: ${situation}`];
  for (const [task, { q, options }] of Object.entries(tasks)) {
    parts.push(descInLabels() ? `Question ${label(task)}: ${q.instructions}`
      : `Question ${label(task)}: ${q.instructions}\nOptions:\n${Object.entries(options).map(([k, v]) => `${label(k)}: ${firstSentences(v, n)}`).join('\n')}`);
  }
  const classifications = Object.fromEntries(Object.entries(tasks).map(([task, { options }]) => [task, {
    labels: descInLabels()
      ? Object.fromEntries(Object.entries(options).map(([k, v]) => [label(k), firstSentences(v, n)]))
      : Object.keys(options).map(label),
    multi_label: true, cls_threshold: 0 }]));
  return { text: parts.join('\n\n'), classifications };
}

/** The text the encoder reads and the tasks it scores, cut to fit the model. */
export function glideRequest(state, questions) {
  const tasks = tasksOf(questions);
  let req;
  for (const n of [Infinity, 6, 4, 3, 2, 1]) {
    req = build(state, tasks, n);
    if (req.text.length + JSON.stringify(req.classifications).length <= budgetChars()) break;
  }
  return req;
}

export function toGlide({ state, questions }) {
  const { text, classifications } = glideRequest(state, questions);
  return {
    model: model(),
    messages: [{ role: 'user', content: text }],
    schema: { classifications },
    include_confidence: true,
  };
}

/** The Fastino reply in the shape Jev answers in. */
export function fromGlide(parsed, questions) {
  let out = {};
  try { out = JSON.parse(parsed?.choices?.[0]?.message?.content ?? '{}'); } catch { /* empty answer */ }
  const answers = {};
  for (const [task, { q, options }] of Object.entries(tasksOf(questions))) {
    const got = [out[task]].flat().filter(Boolean);
    const scores = {};
    for (const name of Object.keys(options)) scores[name] = got.find((g) => g.label === label(name))?.confidence ?? 0;
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    if (!total) continue;
    const probs = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round((100 * v) / total) / 100]));
    const pick = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a));
    if (q.type === 'noul') { answers[task] = { type: 'noul', noul: scores.true / total }; continue; }
    if (q.type === 'score') { answers[task] = { type: 'score', score: Number(pick), confidence: probs[pick] }; continue; }
    // Members back under their kind: the action names the kind, each follow-up its best member.
    const kindOf = (name) => Object.keys(q.criteria).find((k) => questions[`which_${k}`]?.criteria?.[name] !== undefined) ?? name;
    const top = {};
    for (const [name, p] of Object.entries(probs)) top[kindOf(name)] = Math.round(100 * ((top[kindOf(name)] ?? 0) + p)) / 100;
    const kind = kindOf(pick);
    answers[task] = { type: 'choice', choice: kind, confidence: top[kind], probabilities: top };
    for (const k of Object.keys(q.criteria)) {
      const members = questions[`which_${k}`]?.criteria;
      if (!members) continue;
      const sub = Object.fromEntries(Object.keys(members).map((m) => [m, scores[m]]));
      const s = Object.values(sub).reduce((a, b) => a + b, 0) || 1;
      const best = Object.keys(sub).reduce((a, b) => (sub[b] > sub[a] ? b : a));
      answers[`which_${k}`] = { type: 'choice', choice: best, confidence: Math.round((100 * sub[best]) / s) / 100,
        probabilities: Object.fromEntries(Object.entries(sub).map(([m, v]) => [m, Math.round((100 * v) / s) / 100])) };
    }
  }
  return {
    answers,
    model: `glide:${model().replace('fastino/', '')}`,
    usage: { input_tokens: parsed?.usage?.prompt_tokens ?? 0, output_tokens: 0 },
  };
}
