/**
 * Jev client, scoped to a real-time control loop.
 *
 * Derived from `@typesafe-ai/sdk` 0.6.0. What is kept is the part that is
 * tedious to get right and identical everywhere: the error taxonomy, the way a
 * 422 body is turned into a readable message, `Retry-After` parsing, the
 * request-id header, and the question builders.
 *
 * What is replaced is the retry policy. The SDK retries 408/429/5xx with
 * backoff, which is correct for a batch job and wrong inside a game tick: a
 * retry that lands 500 ms late is a decision about a fight that has already
 * moved on. Here a live call gets one attempt and a hard deadline, and a miss
 * degrades to the executor's reflexes. Retries exist only in `replay()`, which
 * runs offline against recorded states where latency does not matter.
 */

export const ENV = {
  apiKey: 'TYPESAFE_API_KEY',
  baseURL: 'TYPESAFE_BASE_URL',
  defaultModel: 'TYPESAFE_DEFAULT_MODEL',
};

const DEFAULTS = {
  baseURL: 'https://api.typesafe.ai',
  model: 'jev-latest',
  /** Per-call ceiling. Beyond this the answer is worthless to a live fight. */
  deadlineMs: 1200,
};

/** Published price, used only to keep a running estimate in the telemetry. */
export const USD_PER_INPUT_TOKEN = 42 / 1e9;

// ---------------------------------------------------------------- errors

export class TypeSafeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

const isRecord = (v) => typeof v === 'object' && v !== null;

/** Pull a message out of a text, error, or FastAPI validation body. */
function extractMessage(body) {
  if (typeof body === 'string') return body || undefined;
  if (!isRecord(body)) return undefined;
  const { error, message, detail } = body;
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  if (typeof message === 'string') return message;
  if (typeof detail === 'string') return detail;
  if (isRecord(detail) && typeof detail.message === 'string') return detail.message;
  if (Array.isArray(detail)) return describeValidationErrors(detail);
  return undefined;
}

/** `questions.action.criteria: field required; ...` — the useful half of a 422. */
function describeValidationErrors(errors) {
  const parts = errors.flatMap((e) => {
    if (!isRecord(e) || typeof e.msg !== 'string') return [];
    const loc = Array.isArray(e.loc) ? e.loc.filter((x) => x !== 'body').join('.') : '';
    return [loc ? `${loc}: ${e.msg}` : e.msg];
  });
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export class APIError extends TypeSafeError {
  constructor(status, body, headers, message) {
    super(message ?? APIError.describe(status, body));
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.requestId = headers?.get('x-typesafe-request-id') ?? undefined;
  }

  static describe(status, body) {
    const detail = extractMessage(body);
    if (detail) return `${status} ${detail}`;
    if (body === undefined) return `${status} status code (no body)`;
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return `${status} ${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}`;
  }

  static fromResponse(status, body, headers) {
    if (status === 401) return new AuthenticationError(status, body, headers);
    if (status === 422) return new UnprocessableEntityError(status, body, headers);
    if (status === 429) return new RateLimitError(status, body, headers);
    if (status >= 500) return new ServerError(status, body, headers);
    return new APIError(status, body, headers);
  }

  /** Whether the same request is worth sending again, offline. */
  get retryable() {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class AuthenticationError extends APIError {}
export class UnprocessableEntityError extends APIError {}
export class ServerError extends APIError {}
export class RateLimitError extends APIError {
  get retryAfterMs() { return parseRetryAfter(this.headers); }
}

/** A call that ran past its deadline. Expected during play, not an outage. */
export class DeadlineExceeded extends TypeSafeError {
  constructor(ms) {
    super(`no answer within ${ms}ms`);
    this.deadlineMs = ms;
  }
}

/** Prefers `retry-after-ms`, falls back to `Retry-After` in seconds or a date. */
export function parseRetryAfter(headers, now = Date.now()) {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

// ---------------------------------------------------------------- client

export function createClient({
  apiKey = process.env[ENV.apiKey],
  baseURL = process.env[ENV.baseURL] ?? DEFAULTS.baseURL,
  model = process.env[ENV.defaultModel] ?? DEFAULTS.model,
  deadlineMs = DEFAULTS.deadlineMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new TypeSafeError(`no API key; set ${ENV.apiKey} or pass apiKey`);

  const url = `${baseURL.replace(/\/+$/, '')}/v1/systemone`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'jev-harness/0.1 (from typesafe-sdk/0.6.0)',
  };

  /** Running totals, read by the telemetry writer at the end of a run. */
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, misses: 0, errors: 0 };

  async function post(body, ms, signal) {
    const timeout = AbortSignal.timeout(ms);
    const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const started = performance.now();

    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abort, keepalive: true });
    } catch (err) {
      if (timeout.aborted) throw new DeadlineExceeded(ms);
      throw err;
    }

    const text = await res.text();
    const parsed = text.length === 0 ? undefined : safeJson(text);
    if (!res.ok) throw APIError.fromResponse(res.status, parsed, res.headers);

    usage.calls++;
    usage.inputTokens += parsed?.usage?.input_tokens ?? 0;
    usage.outputTokens += parsed?.usage?.output_tokens ?? 0;
    return { ...parsed, latencyMs: Math.round(performance.now() - started), requestId: res.headers.get('x-typesafe-request-id') ?? undefined };
  }

  return {
    usage,
    /** Estimated spend so far, from the published input-token price. */
    get costUsd() { return usage.inputTokens * USD_PER_INPUT_TOKEN; },

    /**
     * Opens the connection before the fight needs it. The first call of a run
     * took 700-900 ms against ~300 once warm, and it used to be the first
     * decision, so the fighter stood idle for most of a second at the start.
     * One tiny question costs a few dozen tokens.
     */
    async warm() {
      const t0 = performance.now();
      await this.ask({ state: 'Connection check before a match.', deadlineMs: 5000,
        questions: { ready: { type: 'noul', instructions: 'Is this a connection check?',
          criteria: { true: 'Yes.', false: 'No.' } } } });
      return Math.round(performance.now() - t0);
    },

    /**
     * One judgement, one attempt, one deadline. Returns `null` instead of
     * throwing when the answer did not arrive in time or the service failed,
     * because the caller's only sane response to either is to keep playing.
     * Anything wrong with the *request* still throws — a 401 or a malformed
     * question set is a bug, not weather.
     */
    async ask({ state, questions, deadlineMs: ms = deadlineMs, signal } = {}) {
      validateQuestions(questions);
      try {
        return await post({ model, state, questions }, ms, signal);
      } catch (err) {
        if (err instanceof DeadlineExceeded) { usage.misses++; return null; }
        if (err instanceof APIError && err.retryable) { usage.errors++; return null; }
        if (err?.name === 'AbortError') return null;
        if (err instanceof APIError) throw err;
        usage.errors++;
        return null;
      }
    },

    /**
     * The offline path: recorded states replayed against a revised question
     * schema. Nothing is waiting on the answer, so this is where retries and
     * `Retry-After` belong.
     */
    async replay({ state, questions, maxRetries = 3, deadlineMs: ms = 30000 } = {}) {
      validateQuestions(questions);
      for (let attempt = 0; ; attempt++) {
        try {
          return await post({ model, state, questions }, ms);
        } catch (err) {
          const retryable = err instanceof DeadlineExceeded || (err instanceof APIError && err.retryable);
          if (!retryable || attempt >= maxRetries) throw err;
          const after = err instanceof RateLimitError ? err.retryAfterMs : undefined;
          await sleep(after ?? Math.min(500 * 2 ** attempt, 5000));
        }
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (text) => { try { return JSON.parse(text); } catch { return text; } };

// ------------------------------------------------------------- questions

/** 0–1 probability. `criteria` describes what true and false mean. */
export const noul = (instructions, criteria) => ({ type: 'noul', instructions, criteria });

/** Named alternatives. `criteria` maps each label to what it means. */
export const choice = (instructions, criteria) => {
  if (Array.isArray(criteria)) throw new TypeSafeError('choice criteria must be a map of labels to descriptions');
  return { type: 'choice', instructions, criteria };
};

/** Ordered rubric. `criteria` is a list of level descriptions from zero up. */
export const score = (instructions, criteria) => {
  if (!Array.isArray(criteria)) throw new TypeSafeError('score criteria must be a list indexed from zero');
  return { type: 'score', instructions, criteria };
};

export function validateQuestions(questions) {
  if (!questions || Object.keys(questions).length === 0) throw new TypeSafeError('at least one question is required');
  for (const [name, q] of Object.entries(questions)) {
    if (q.type !== 'score') continue;
    if (!Array.isArray(q.criteria)) throw new TypeSafeError(`score question "${name}" needs a list of criteria`);
    if (q.criteria.length < 2) throw new TypeSafeError(`score question "${name}" has ${q.criteria.length} criteria; at least two are required`);
  }
}
