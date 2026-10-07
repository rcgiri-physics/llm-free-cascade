/**
 * llm-free-cascade
 *
 * Calls a chat-completion-shaped LLM across a chain of providers, trying the
 * next one whenever the current one is rate-limited, out of quota, or errors.
 * Every provider it knows about has (or had, at time of writing) a free tier —
 * the point is to stack several free accounts instead of paying for one.
 *
 * Supported providers: gemini, groq, cerebras, sambanova, mistral, openrouter,
 * together, deepseek, cohere, huggingface, cloudflare, zhipu, nvidia,
 * opencode, pollinations, anthropic (paid, intended as a last-resort tier
 * rather than a free one).
 *
 * Zero dependencies — uses global fetch (Node 18+).
 */

'use strict';

// Single source of truth for provider metadata (base URL, default model, env
// var, free-tier notes). A contributor fixing a retired model name or adding
// a new free-tier provider only needs to touch this JSON file, not the
// dispatch logic below. See CONTRIBUTING.md.
const PROVIDERS_META = require('./providers.json');

const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULT_MODELS = Object.fromEntries(
  Object.entries(PROVIDERS_META).map(([provider, meta]) => [provider, meta.defaultModel])
);

const ALL_PROVIDERS = Object.keys(PROVIDERS_META);

// provider -> env var name, used only by fromEnv()
const PROVIDER_ENV = Object.fromEntries(
  Object.entries(PROVIDERS_META).map(([provider, meta]) => [provider, meta.envVar])
);

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_TOKENS = 1024;
// Upper bound on how much of a provider's error body we keep. Everything
// downstream (redact, hooks, the thrown error) is sized by this.
const MAX_ERROR_DETAIL_CHARS = 2000;
// Longest message redact() will scan. Anything past this is noise, and
// bounding the input is what keeps the regex pass linear-time in practice.
const MAX_REDACT_CHARS = 8192;
// A single SSE event larger than this is not a chat-completion delta — it's
// a misbehaving upstream. Bounding the buffer keeps a provider that never
// sends an event boundary from growing our heap without limit.
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
// No cooldown (or Retry-After) is ever longer than a day, and none shorter than a second.
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_COOLDOWN_MS = 1000;
// "Rolling" daily limits have no clock-time reset we can compute, so a
// day-exhausted slot is re-checked about once an hour.
const ROLLING_DAY_RECHECK_MS = 60 * 60 * 1000;
// Circuit breaker: this many consecutive timeouts / network errors / 5xx in a
// row from one provider benches it for `breakerMs` instead of paying the full
// timeout again on every call.
const BREAKER_THRESHOLD = 2;
const DEFAULT_BREAKER_MS = 60 * 1000;
const LATENCY_SAMPLES = 50;
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FORBIDDEN_CUSTOM_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'host', 'x-api-key', 'x-goog-api-key']);

class LLMCascadeError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=502]
   * @param {string|null} [code=null]
   * @param {{provider: string, message: string}[]} [failures=[]] - per-provider
   *   redacted failure messages. Log these; don't forward them to end users.
   */
  constructor(message, statusCode = 502, code = null, failures = []) {
    super(message);
    this.name = 'LLMCascadeError';
    this.statusCode = statusCode;
    this.code = code;
    this.failures = failures;
  }
}

const CONTEXT_RE = /context.{0,30}(length|window)|maximum.{0,20}(context|length)|too (long|large)|reduce the (length|size)|token limit|exceeds? the (model|maximum|max)|prompt is too/i;

/**
 * What a failure means for the NEXT attempt, decided from its message:
 *  - `request`: this particular prompt is the problem (context too long, 413).
 *    Another key or model of the same provider won't help and the provider
 *    itself is fine, so it is skipped for this call only, with no cooldown.
 *  - `rate`: 429 / quota. Only that key+model "slot" is spent — try the next
 *    key, then the next model.
 *  - `auth`: 401/403 / bad key. That key is dead — try the next key.
 *  - `model`: the model is gone or unsupported (404 etc.) — try the next model.
 *  - `fatal`: anything else; stop retrying this provider.
 */
function classifyFailure(message = '') {
  if (/\bHTTP (400|413|422)\b/.test(message) && CONTEXT_RE.test(message)) return 'request';
  if (/\b429\b|quota|rate.?limit|too many requests|exhaust/i.test(message)) return 'rate';
  if (/\b(401|403)\b|invalid.{0,12}key|api key|unauthori[sz]ed|forbidden/i.test(message)) return 'auth';
  if (/\bHTTP 404\b|model.{0,40}(not found|does not exist|decommission|deprecat|no longer|not supported|unavailable)|(unknown|invalid|unsupported).{0,20}model/i.test(message)) return 'model';
  return 'fatal';
}

/** Timeouts, dropped connections and 5xx: likely to clear on their own, but costly to retry on every call. */
function isTransientFailure(message = '') {
  return /timed out|network error|\bHTTP 5\d\d\b|unparseable/i.test(message);
}

/**
 * Parses "33.1s", "2m59.52s", "250ms", "1h2m" (what Gemini and Groq put in
 * their 429 text/headers) — or a bare number of seconds (a Retry-After
 * header) — into milliseconds. `undefined` when it isn't a duration.
 */
function parseDurationMs(value) {
  if (value == null) return undefined;
  const s = String(value).trim().slice(0, 64);
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const units = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(m[1]) * units[m[2]];
  }
  return matched ? total : undefined;
}

/** `ms` as a usable cooldown (finite, within [1s, 24h]), or `undefined` if it isn't one. */
function clampCooldown(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(ms, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS) : undefined;
}

function headerValue(headers, name) {
  try {
    return headers && typeof headers.get === 'function' ? headers.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Retry-After (seconds or an HTTP date) in ms, or `undefined`. Tolerates test doubles with no `headers`. */
function retryAfterFromHeaders(headers) {
  const raw = headerValue(headers, 'retry-after');
  if (!raw) return undefined;
  const asDuration = parseDurationMs(raw);
  if (asDuration != null) return clampCooldown(asDuration);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? clampCooldown(when - Date.now()) : undefined;
}

/** A "please retry in 33.1s" / "try again in 2m59.5s" hint inside a provider's own error text. */
function retryHintFromMessage(message = '') {
  const m = /(?:retry|try again)(?: again)? in ([0-9.]+(?:ms|h|m|s)(?:[0-9.]+(?:ms|h|m|s))*)/i.exec(message)
    || /retry after (\d+)\s?(?:seconds|secs|s)\b/i.exec(message);
  return m ? clampCooldown(parseDurationMs(m[1] + (/^\d+$/.test(m[1]) ? 's' : ''))) : undefined;
}

/** Which window a rate-limit message is about, when it says: `'day'`, `'minute'`, or `null`. */
function rateWindow(message = '') {
  if (/per[ -]?day|\bdaily\b|\bRPD\b|\bTPD\b|PerDay/i.test(message)) return 'day';
  if (/per[ -]?minute|\bRPM\b|\bTPM\b|PerMinute/i.test(message)) return 'minute';
  return null;
}

/** ms until the next local midnight in an IANA `timeZone` (+1s of slack). One hour if the zone is unusable. */
function msUntilMidnight(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
    if (!Number.isFinite(elapsed)) throw new Error('bad time');
    return (86400 - elapsed) * 1000 + 1000;
  } catch {
    return ROLLING_DAY_RECHECK_MS;
  }
}

/** Attaches the server's Retry-After (429/503 only) to an error so the cascade can cool the slot for exactly that long. */
function withRetry(err, res) {
  if (res && (res.status === 429 || res.status === 503)) {
    const ms = retryAfterFromHeaders(res.headers);
    if (ms) err.retryAfterMs = ms;
  }
  return err;
}

/** Re-throws `err` with a provider prefix while keeping the structured fields the cascade reads. */
function prefixError(prefix, err) {
  const out = new Error(`${prefix} ${err.message}`);
  if (err.retryAfterMs) out.retryAfterMs = err.retryAfterMs;
  return out;
}

/**
 * A base URL we're willing to send a bearer token to: https, or plain http
 * only for localhost (a self-hosted gateway). No embedded credentials.
 */
function validateBaseUrl(raw, label) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`${label}: baseUrl must be a valid URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`${label}: baseUrl must be https:// (http:// is allowed only for localhost)`);
  }
  if (u.username || u.password) throw new Error(`${label}: baseUrl must not embed credentials`);
  return u.href.replace(/\/+$/, '');
}

/** Structural faults that will recur for the whole run — worth a cooldown. */
function isProviderLevelFailure(message = '') {
  return /MAX_TOKENS|no content|HTTP 4\d\d|unknown provider|no API key/i.test(message);
}

/** A rate-limit / quota failure — cooled down for `rateLimitCooldownMs` rather than the structural `cooldownMs`. */
function isRateLimitFailure(message = '') {
  return /\b429\b|quota|rate.?limit/i.test(message);
}

/** A usable timeout in ms: finite and positive, otherwise the default. `0`/negative/NaN are treated as "not set", not "no timeout". */
function resolveTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

/** A usable max_tokens: a positive integer, optionally clamped to `limit`, otherwise the default. */
function resolveMaxTokens(maxTokens, limit) {
  let n = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS;
  if (Number.isFinite(limit) && limit > 0) n = Math.min(n, Math.floor(limit));
  return n;
}

/** A promise that rejects with an AbortError when `signal` fires (never resolves). */
function abortRejection(signal) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function timeoutMessage(err, ms) {
  return err && err.name === 'AbortError' ? `timed out after ${ms}ms` : err.message;
}

/**
 * POST + parse JSON with a hard timeout that covers the WHOLE exchange —
 * connect, headers, and reading/parsing the body. (Clearing the timer once
 * headers arrive would let a provider that sends `200 OK` and then stalls the
 * body hang the cascade forever, with no fallover.) The AbortController/timer
 * are always torn down in `finally`.
 *
 * Errors are prefixed with the provider name so key-rotation/cooldown logic
 * and the final aggregated error read the same for every provider:
 *   `<provider> network error: ...`  — DNS/TCP/TLS failure or timeout
 *   `<provider> HTTP <status>: ...`  — non-2xx, with the provider's own detail
 */
async function fetchJson(provider, url, options, timeoutMs) {
  const controller = new AbortController();
  const ms = resolveTimeout(timeoutMs);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    let res;
    try {
      res = await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      throw new Error(`${provider} network error: ${timeoutMessage(err, ms)}`);
    }
    if (!res.ok) throw withRetry(new Error(`${provider} HTTP ${res.status}: ${await extractErrorDetail(res)}`), res);
    try {
      // Raced against the abort signal, so the timeout holds even if a body
      // implementation ignores the signal it was given.
      return await Promise.race([res.json(), abortRejection(controller.signal)]);
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error(`${provider} network error: ${timeoutMessage(err, ms)}`);
      throw new Error(`${provider} returned an unparseable response body`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams an SSE (`text/event-stream`) response, yielding each `data:`
 * payload as a raw string (skipping `[DONE]`, comments, and non-data lines).
 *
 * Timeouts are per-*read*, not per-stream: `firstByteMs` bounds the wait for
 * the response headers, then `idleMs` is re-armed after every chunk, so a
 * long generation that keeps producing tokens is never cut off, but a stream
 * that goes quiet is. Either timeout surfaces as `timed out after …ms` so the
 * consumer can tell it apart from a provider error.
 *
 * The AbortController/timer/reader are always released in `finally` —
 * whether the stream ends naturally, errors, or the consumer stops
 * iterating early (a `break` in a `for await` loop calls this generator's
 * `.return()`, which runs `finally` just like a thrown error would) — so an
 * abandoned stream never leaks an open reader/socket.
 */
async function* streamSSE(url, options, { firstByteMs, idleMs }) {
  const controller = new AbortController();
  const connectMs = resolveTimeout(firstByteMs);
  const quietMs = resolveTimeout(idleMs);
  let timer = setTimeout(() => controller.abort(), connectMs);
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), quietMs);
  };

  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`network error: ${timeoutMessage(err, connectMs)}`);
  }
  if (!res.ok) {
    const detail = await extractErrorDetail(res); // read while the timer is still armed
    clearTimeout(timer);
    throw withRetry(new Error(`HTTP ${res.status}: ${detail}`), res);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new Error('returned an empty response body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotData = false;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw new Error(`network error: ${timeoutMessage(err, gotData ? quietMs : connectMs)}`);
      }
      if (chunk.done) break;
      gotData = true;
      rearm();
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes without a boundary`);
      }
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          yield payload;
        }
      }
    }
  } finally {
    reader.releaseLock();
    controller.abort(); // no-op if the stream already ended naturally
    clearTimeout(timer);
  }
}

async function extractErrorDetail(res) {
  try {
    const body = await res.json();
    const detail = body?.error?.message || body?.message;
    return detail ? String(detail).slice(0, MAX_ERROR_DETAIL_CHARS) : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Strips anything that looks like a credential out of a provider error
 * message before it's logged or surfaced — a provider can echo a key
 * fragment back in its own error body.
 *
 * Two passes: (1) every literal in `secrets` (the cascade passes the keys it
 * actually holds — deterministic, catches any phrasing), then (2) a
 * keyword-shaped fallback for tokens we don't know about. The regexes use
 * bounded whitespace classes (`[ \t]{0,4}`) rather than `\s*`, and the input
 * is capped at MAX_REDACT_CHARS, so the pass stays linear — two adjacent
 * unbounded `\s*` on a long run of spaces is a quadratic-backtracking DoS.
 */
function redact(message, secrets = []) {
  let out = String(message).slice(0, MAX_REDACT_CHARS);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out
    .replace(/\b(api[ _-]?key|authorization|bearer)\b([ \t]{0,4}[:=]?[ \t]{0,4})[A-Za-z0-9._-]{8,}/gi, '$1$2[redacted]')
    .replace(/\bBearer[ \t]{1,4}[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

// Plain string ops instead of `/\s*```\s*$/` — that regex is quadratic on a
// long whitespace tail (each start position re-scans to the end).
function stripFences(text) {
  let s = String(text).trim();
  if (s.startsWith('```')) {
    s = s.slice(3);
    if (s.slice(0, 4).toLowerCase() === 'json') s = s.slice(4);
    s = s.trimStart();
  }
  if (s.endsWith('```')) s = s.slice(0, -3).trimEnd();
  return s;
}

/**
 * Best-effort JSON.parse that also finds and parses the first balanced
 * {...}/[...] block inside a larger string — handy because models routinely
 * wrap JSON in prose or markdown fences despite being told not to.
 */
function parseJsonLoose(text) {
  const stripped = stripFences(text);
  try { return JSON.parse(stripped); } catch { /* fall through */ }

  const start = stripped.search(/[{[]/);
  if (start === -1) return undefined;
  const open = stripped[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/** Normalizes a provider's usage block into {promptTokens, completionTokens, totalTokens}, or undefined if the provider didn't report one. */
function normalizeUsage(u) {
  if (!u) return undefined;
  // Gemini's usageMetadata uses different field names than the OpenAI/Anthropic shape.
  const prompt = u.promptTokenCount ?? u.prompt_tokens ?? u.input_tokens;
  const completion = u.candidatesTokenCount ?? u.completion_tokens ?? u.output_tokens;
  const total = u.totalTokenCount ?? u.total_tokens ?? (prompt != null && completion != null ? prompt + completion : undefined);
  if (prompt == null && completion == null && total == null) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/**
 * Normalizes {user, messages} into a non-empty `{role, content}[]`. `user` is
 * sugar for a single-turn `[{role: 'user', content: user}]`; `messages`
 * (when given) wins outright, so a caller building real multi-turn history
 * doesn't need to also pass `user`.
 */
function normalizeMessages({ user, messages }) {
  if (Array.isArray(messages) && messages.length) return validateMessages(messages);
  if (typeof user === 'string') return [{ role: 'user', content: user }];
  throw invalidInput('generate() requires either "user" (a string) or a non-empty "messages" array');
}

const MESSAGE_ROLES = new Set(['user', 'assistant']);

/**
 * `messages` is the one param a host app is likely to build from a client's
 * request body, so it's validated strictly and rebuilt as fresh
 * `{role, content}` objects rather than forwarded verbatim:
 *  - role must be `user` or `assistant`. Anything else — a client-supplied
 *    `system` turn that would override the app's own system prompt, `tool`,
 *    `developer` — is rejected, not coerced.
 *  - content must be a non-empty string. Object/array content (image URLs
 *    the provider would fetch, tool results) isn't supported here.
 *  - extra fields (`name`, `tool_calls`, …) are dropped, never forwarded.
 *  - the first turn must be `user` (Anthropic and Gemini require it).
 * A malformed history fails fast with INVALID_INPUT instead of becoming a
 * provider 4xx — which would count as a provider-level failure and put that
 * provider on cooldown for everyone.
 */
function validateMessages(messages) {
  const out = messages.map((m, i) => {
    if (!m || typeof m !== 'object') throw invalidInput(`messages[${i}] must be an object`);
    if (!MESSAGE_ROLES.has(m.role)) throw invalidInput(`messages[${i}].role must be "user" or "assistant"`);
    if (typeof m.content !== 'string' || !m.content.trim()) throw invalidInput(`messages[${i}].content must be a non-empty string`);
    return { role: m.role, content: m.content };
  });
  if (out[0].role !== 'user') throw invalidInput('messages[0].role must be "user"');
  return out;
}

function invalidInput(message) {
  return new LLMCascadeError(message, 400, 'INVALID_INPUT');
}

// ---- request-body builders (shared by the blocking and streaming callers) ----

function geminiBody({ system, messages, json, maxTokens, noThinking }) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    // Gemini's wire format calls the assistant turn "model", not "assistant".
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  // gemini-2.5-flash "thinks" by default, spending the output budget on
  // reasoning before any JSON — which can starve short structured calls into
  // MAX_TOKENS. `noThinking` disables it for deterministic/classification
  // tasks that don't benefit from it.
  if (noThinking) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return body;
}

function openAICompatBody({ system, messages, json, maxTokens, model, stream }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };
  if (stream) body.stream = true;
  return body;
}

function anthropicBody({ system, messages, json, schema, maxTokens, model, stream }) {
  const body = { model, max_tokens: maxTokens, system, messages };
  if (json && schema) body.output_config = { format: { type: 'json_schema', schema } };
  if (stream) body.stream = true;
  return body;
}

const jsonHeaders = (auth) => ({ 'content-type': 'application/json', ...auth });

async function callGemini(opts) {
  const { apiKey, model, attemptTimeoutMs, baseUrl } = opts;
  const url = `${baseUrl}/${encodeURIComponent(model)}:generateContent`;
  const data = await fetchJson('gemini', url, {
    method: 'POST',
    headers: jsonHeaders({ 'x-goog-api-key': apiKey }),
    body: JSON.stringify(geminiBody(opts)),
  }, attemptTimeoutMs);

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason;
    throw new Error(`gemini returned no content${reason ? ` (${reason})` : ''}`);
  }
  return { text, usage: normalizeUsage(data.usageMetadata) };
}

/** Shared OpenAI-compatible caller (Groq, Cerebras, SambaNova, Mistral, OpenRouter, Together, DeepSeek, Cohere, HF, Cloudflare). */
async function callOpenAICompat(opts) {
  const { baseUrl, apiKey, provider, extraHeaders, attemptTimeoutMs } = opts;
  const data = await fetchJson(provider, `${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders({ authorization: `Bearer ${apiKey}`, ...extraHeaders }),
    body: JSON.stringify(openAICompatBody(opts)),
  }, attemptTimeoutMs);

  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error(`${provider} returned an empty response`);
  return { text, usage: normalizeUsage(data.usage) };
}

async function callAnthropic(opts) {
  const { apiKey, attemptTimeoutMs, baseUrl } = opts;
  const data = await fetchJson('anthropic', baseUrl, {
    method: 'POST',
    headers: jsonHeaders({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
    body: JSON.stringify(anthropicBody(opts)),
  }, attemptTimeoutMs);

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('anthropic returned an empty response');
  return { text, usage: normalizeUsage(data.usage) };
}

// Cloudflare account IDs are 32 hex chars. The ID is spliced into a URL
// path, so anything else (a `../`, a `?`) would redirect the bearer token to
// an attacker-chosen path on the same host — reject it rather than encode it.
const CLOUDFLARE_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

/** Shared per-provider setup (Cloudflare's per-account base URL, OpenRouter's / custom providers' extra headers) used by both the non-streaming and streaming openai-compat callers. */
function resolveOpenAICompatTarget(provider, meta, opts) {
  let baseUrl = meta.baseUrl;
  if (provider === 'cloudflare') {
    const id = opts.cloudflareAccountId;
    if (!id) throw new Error('cloudflare: cloudflareAccountId is required');
    if (!CLOUDFLARE_ACCOUNT_ID_RE.test(String(id))) throw new Error('cloudflare: cloudflareAccountId must be a 32-character hex account ID');
    baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(id)}/ai/v1`;
  }
  const headers = { ...(meta.headers || {}) };
  if (meta.extraHeaders === true) {
    headers['HTTP-Referer'] = opts.referer || 'https://github.com';
    headers['X-Title'] = opts.appName || 'llm-free-cascade';
  }
  return { baseUrl, extraHeaders: Object.keys(headers).length ? headers : undefined };
}

/**
 * Dispatches on each provider's `apiStyle` from providers.json instead of a
 * hardcoded per-provider switch, so adding a new OpenAI-compatible free-tier
 * provider is a JSON-only change (see CONTRIBUTING.md) — no code touched
 * unless the provider needs bespoke request/response handling like Gemini
 * and Anthropic do. `meta` is the (per-instance) metadata for `provider`, so a
 * `baseUrls` override or a `custom` provider is honoured.
 */
function callProviderWithKey(provider, meta, opts, apiKey, model) {
  if (!meta) return Promise.reject(new Error(`unknown provider: ${provider}`));

  if (meta.apiStyle === 'gemini') return callGemini({ ...opts, apiKey, model, baseUrl: meta.baseUrl });
  if (meta.apiStyle === 'anthropic') return callAnthropic({ ...opts, apiKey, model, baseUrl: meta.baseUrl });

  if (meta.apiStyle === 'openai-compat') {
    let target;
    try {
      target = resolveOpenAICompatTarget(provider, meta, opts);
    } catch (err) {
      return Promise.reject(err);
    }
    return callOpenAICompat({ ...opts, baseUrl: target.baseUrl, model, apiKey, provider, extraHeaders: target.extraHeaders });
  }

  return Promise.reject(new Error(`${provider}: unknown apiStyle "${meta.apiStyle}"`));
}

const streamTimeouts = (opts) => ({ firstByteMs: opts.attemptTimeoutMs ?? opts.timeoutMs, idleMs: opts.timeoutMs });

async function* streamGemini(opts) {
  const { apiKey, model, baseUrl } = opts;
  const url = `${baseUrl}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  try {
    for await (const payload of streamSSE(url, {
      method: 'POST',
      headers: jsonHeaders({ 'x-goog-api-key': apiKey }),
      body: JSON.stringify(geminiBody(opts)),
    }, streamTimeouts(opts))) {
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (text) yield text;
    }
  } catch (err) {
    throw prefixError('gemini', err);
  }
}

/** Shared streaming caller for the OpenAI-compatible providers — same SSE `choices[0].delta.content` shape across all of them. */
async function* streamOpenAICompat(opts) {
  const { baseUrl, apiKey, provider, extraHeaders } = opts;
  try {
    for await (const payload of streamSSE(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: jsonHeaders({ authorization: `Bearer ${apiKey}`, ...extraHeaders }),
      body: JSON.stringify(openAICompatBody({ ...opts, stream: true })),
    }, streamTimeouts(opts))) {
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  } catch (err) {
    throw prefixError(provider, err);
  }
}

async function* streamAnthropic(opts) {
  const { apiKey, baseUrl } = opts;
  try {
    for await (const payload of streamSSE(baseUrl, {
      method: 'POST',
      headers: jsonHeaders({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
      body: JSON.stringify(anthropicBody({ ...opts, stream: true })),
    }, streamTimeouts(opts))) {
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') yield data.delta.text;
    }
  } catch (err) {
    throw prefixError('anthropic', err);
  }
}

/** Streaming counterpart of callProviderWithKey — same apiStyle dispatch, returns an async generator of text chunks instead of a Promise. */
function streamProviderWithKey(provider, meta, opts, apiKey, model) {
  if (!meta) throw new Error(`unknown provider: ${provider}`);

  if (meta.apiStyle === 'gemini') return streamGemini({ ...opts, apiKey, model, baseUrl: meta.baseUrl });
  if (meta.apiStyle === 'anthropic') return streamAnthropic({ ...opts, apiKey, model, baseUrl: meta.baseUrl });

  if (meta.apiStyle === 'openai-compat') {
    const { baseUrl, extraHeaders } = resolveOpenAICompatTarget(provider, meta, opts);
    return streamOpenAICompat({ ...opts, baseUrl, model, apiKey, provider, extraHeaders });
  }

  throw new Error(`${provider}: unknown apiStyle "${meta.apiStyle}"`);
}

/**
 * Builds this instance's provider metadata: a private copy of providers.json
 * (so a `baseUrls` override never leaks into other instances) plus any
 * `custom` providers. Custom providers are always OpenAI-compatible
 * (`/chat/completions`) — that covers self-hosted gateways (OmniRoute,
 * LiteLLM), community routers, and any provider not in providers.json yet.
 */
function buildMeta(options) {
  const meta = Object.create(null);
  for (const [provider, m] of Object.entries(PROVIDERS_META)) meta[provider] = { ...m };

  const customKeys = {};
  for (const [name, c] of Object.entries(options.custom || {})) {
    if (!CUSTOM_NAME_RE.test(name)) throw new Error(`custom provider name "${name}" must match ${CUSTOM_NAME_RE}`);
    if (Object.hasOwn(PROVIDERS_META, name)) throw new Error(`custom provider "${name}" would shadow a built-in provider; pick another name or use "baseUrls"`);
    if (!c || typeof c !== 'object') throw new Error(`custom provider "${name}" must be an object`);
    const models = (Array.isArray(c.models) ? c.models : [c.model]).filter((m) => typeof m === 'string' && m.trim());
    if (!models.length) throw new Error(`custom provider "${name}" needs a "model" (string) or "models" (non-empty array)`);

    const headers = {};
    for (const [h, v] of Object.entries(c.headers || {})) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(h) || FORBIDDEN_CUSTOM_HEADERS.has(h.toLowerCase())) throw new Error(`custom provider "${name}": header "${h}" is not allowed`);
      if (typeof v !== 'string' || v.length > 512 || /[\r\n]/.test(v)) throw new Error(`custom provider "${name}": header "${h}" has an invalid value`);
      headers[h] = v;
    }

    meta[name] = {
      envVar: null,
      apiStyle: 'openai-compat',
      baseUrl: validateBaseUrl(c.baseUrl, `custom provider "${name}"`),
      defaultModel: models[0],
      fallbackModels: models.slice(1),
      tier: Number.isFinite(c.tier) ? c.tier : 3,
      headers,
      dayReset: typeof c.dayReset === 'string' ? c.dayReset : undefined,
      signupUrl: null,
      freeTierNotes: 'custom provider',
      custom: true,
    };
    const supplied = c.apiKeys ?? c.apiKey;
    if (supplied) customKeys[name] = Array.isArray(supplied) ? supplied : [supplied];
  }

  for (const [provider, url] of Object.entries(options.baseUrls || {})) {
    if (!Object.hasOwn(meta, provider)) throw new Error(`baseUrls: unknown provider "${provider}"`);
    meta[provider].baseUrl = validateBaseUrl(url, `baseUrls.${provider}`);
  }
  return { meta, customKeys };
}

/**
 * @typedef {Object} LLMCascadeOptions
 * @property {Object<string,string|string[]>} keys - provider -> API key(s). A provider with no key is skipped.
 * @property {string[]} [order] - provider order to try. Defaults to all providers that have a key, in tier order (see providers.json). Duplicates are ignored.
 * @property {Object<string,string|string[]>} [models] - provider -> model name override. A string pins exactly that model; an array is an ordered list tried in turn (a 429 on the first falls to the second on the same key before leaving the provider). Without an entry, providers.json's `defaultModel` then `fallbackModels` are used.
 * @property {Object<string,{baseUrl: string, model?: string, models?: string[], apiKey?: string, apiKeys?: string[], tier?: number, headers?: Object<string,string>, dayReset?: string}>} [custom] - extra OpenAI-compatible providers (self-hosted gateway, community router, …). `baseUrl` must be https (or http on localhost).
 * @property {Object<string,string>} [baseUrls] - provider -> base URL override for a built-in provider (e.g. the China Zhipu endpoint, or routing one provider through your own proxy).
 * @property {string} [cloudflareAccountId] - required only if using the cloudflare provider (32-char hex account ID).
 * @property {number} [cooldownMs=600000] - how long to skip a provider after a structural failure.
 * @property {number} [rateLimitCooldownMs] - pins how long a rate-limit/quota failure (429) cools a key+model and, once every key/model is spent, the provider. When NOT set, the cooldown is reset-aware: the server's Retry-After (or a "retry in 33s" hint in the error), else a minute for a per-minute limit, else until the provider's daily reset, else `cooldownMs`.
 * @property {number} [breakerMs=60000] - circuit breaker: after 2 consecutive timeouts/network errors/5xx from a provider, skip it for this long instead of paying the timeout on every call. 0 disables.
 * @property {Object<string,number>} [providerTimeoutMs] - per-provider default timeout (e.g. `{ groq: 10000 }` so a fast provider fails fast). A `timeoutMs` passed to `generate()` still wins.
 * @property {boolean} [adaptiveOrder=false] - within each run of same-tier providers, reorder by observed latency and success rate once there are enough samples. Providers with too few samples keep their place.
 * @property {number} [deadlineMs] - total time budget for one `generate()` call across every provider it tries. Without it, the worst case is `timeoutMs` × (number of providers). Exceeding it throws an LLMCascadeError with code `DEADLINE_EXCEEDED`.
 * @property {number} [maxTokensLimit] - hard ceiling applied to every call's `maxTokens`, so a caller-supplied value can never exceed it (cost control when `maxTokens` comes from an untrusted request).
 * @property {string} [appName] - sent as OpenRouter's X-Title header.
 * @property {string} [referer] - sent as OpenRouter's HTTP-Referer header.
 * @property {number} [timeoutMs=30000] - default per-attempt fetch timeout (covers connect + headers + body); overridable per-call via `generate({ timeoutMs })`. For streams it's the time-to-first-byte and then an idle timeout re-armed after every chunk. A timeout is treated as a normal provider failure (cascade moves to the next provider). Non-positive/non-finite values fall back to the default.
 * @property {{get: (provider: string) => (number|Promise<number>), set: (provider: string, until: number) => (void|Promise<void>), getMany?: (providers: string[]) => (number[]|Promise<number[]>)}} [cooldownStore] - where PROVIDER-level cooldown timestamps live. Defaults to an in-memory Map (per-instance only); pass a shared store (e.g. Redis-backed) to coordinate cooldowns across processes/instances. An optional `getMany` lets a remote store answer for the whole chain in one round-trip. Per-key and per-model cooldowns are always in-process.
 * @property {(provider: string) => (string|null|undefined)} [modelResolver] - called before every attempt to resolve a live model override (e.g. from a DB/admin panel); falls back to `models[provider]` when it returns null/undefined or throws. A resolved model is used alone (no fallback models).
 * @property {(provider: string, message: string) => void} [onProviderFailure] - called once per failed provider, before the cooldown decision.
 * @property {(provider: string, cooldownMs: number) => void} [onProviderCooldown] - called when a provider is put on cooldown.
 * @property {(attempt: {provider: string, model: string, keyIndex: number, ok: boolean, ms: number, kind?: string, error?: string, at: number}) => void} [onAttempt] - called after every single HTTP attempt (each key × model tried), success or failure. `error` is redacted; key material is never included.
 */
class LLMCascade {
  /** @param {LLMCascadeOptions} options */
  constructor(options = {}) {
    const { meta, customKeys } = buildMeta(options);
    this._meta = meta;

    const defaults = Object.fromEntries(Object.entries(meta).map(([provider, m]) => [provider, m.defaultModel]));
    this.models = { ...defaults };
    this._modelLists = Object.create(null); // provider -> explicit ordered model list
    this._pinned = new Set(); // providers whose model the caller set explicitly (no fallbackModels)
    for (const [provider, value] of Object.entries(options.models || {})) {
      const list = (Array.isArray(value) ? value : [value]).filter((m) => typeof m === 'string' && m.trim());
      if (!list.length || !Object.hasOwn(meta, provider)) continue;
      this.models[provider] = list[0];
      this._pinned.add(provider);
      if (list.length > 1) this._modelLists[provider] = [...new Set(list)];
    }

    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this._rateLimitPinned = options.rateLimitCooldownMs != null;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? this.cooldownMs;
    this.breakerMs = options.breakerMs ?? DEFAULT_BREAKER_MS;
    this.providerTimeoutMs = options.providerTimeoutMs || {};
    this.adaptiveOrder = Boolean(options.adaptiveOrder);
    this.deadlineMs = options.deadlineMs;
    this.maxTokensLimit = options.maxTokensLimit;
    this.appName = options.appName;
    this.referer = options.referer;
    this.cloudflareAccountId = options.cloudflareAccountId;
    this.modelResolver = options.modelResolver;
    this.onProviderFailure = options.onProviderFailure;
    this.onProviderCooldown = options.onProviderCooldown;
    this.onAttempt = options.onAttempt;
    this.timeoutMs = options.timeoutMs;
    // In-memory default; a caller can pass `cooldownStore` (e.g. backed by
    // Redis) to share provider-level cooldown state across processes/instances.
    const cooldownUntil = new Map();
    this.cooldownStore = options.cooldownStore || {
      get: (provider) => cooldownUntil.get(provider) || 0,
      set: (provider, until) => { cooldownUntil.set(provider, until); },
    };

    // Per-key / per-model / per-(key,model) cooldowns, round-robin cursors,
    // transient-failure counters and stats. Always in-process: a key's index is
    // only meaningful inside the instance that holds the key list.
    this._cool = new Map();
    this._rr = new Map();
    this._transient = new Map();
    this._stats = new Map();
    this._startedAt = Date.now();

    const rawKeys = options.keys || {};
    this.keys = {};
    for (const provider of Object.keys(meta)) {
      const v = (Object.hasOwn(rawKeys, provider) ? rawKeys[provider] : undefined) ?? customKeys[provider];
      if (!v) continue;
      this.keys[provider] = (Array.isArray(v) ? v : [v]).filter((k) => typeof k === 'string' && k);
    }
    // Every key we hold, so redaction can scrub the literal value from any
    // provider error regardless of how the provider phrased it.
    this._secrets = Object.values(this.keys).flat();

    // Registry order is tier order (providers.json is kept sorted by tier);
    // custom providers slot in by their `tier`. A stable sort, so equal tiers
    // keep their listed order.
    const registry = Object.keys(meta)
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => (meta[a.provider].tier ?? 3) - (meta[b.provider].tier ?? 3) || a.index - b.index)
      .map((x) => x.provider);

    // De-duplicated: `order: ['groq', 'groq']` (easy to do via LLM_PROVIDER_ORDER)
    // would otherwise make the same provider fail twice per call.
    this.order = this._withKeys(options.order || registry);
  }

  /**
   * Build a cascade straight from process.env, using the same var names
   * ai.service.js does: GEMINI_API_KEY, GEMINI_API_KEY_2..9, GROQ_API_KEY, etc.
   * A comma-separated primary var (`GEMINI_API_KEY=key1,key2`) also works.
   * Also reads `<PROVIDER>_BASE_URL` (e.g. ZHIPU_BASE_URL) and
   * `LLM_CUSTOM_PROVIDERS` (a JSON object of custom providers).
   * @param {Object} [options] - same as the constructor, keys/order are derived from env and merged in.
   */
  static fromEnv(options = {}) {
    const keys = {};
    for (const [provider, envVar] of Object.entries(PROVIDER_ENV)) {
      const collected = [];
      for (const part of String(process.env[envVar] || '').split(',')) {
        const t = part.trim();
        if (t) collected.push(t);
      }
      for (let i = 2; i <= 9; i++) {
        const t = String(process.env[`${envVar}_${i}`] || '').trim();
        if (t) collected.push(t);
      }
      if (collected.length) keys[provider] = [...new Set(collected)];
    }
    const baseUrls = {};
    for (const provider of ALL_PROVIDERS) {
      const url = String(process.env[`${provider.toUpperCase()}_BASE_URL`] || '').trim();
      if (url) baseUrls[provider] = url;
    }
    let custom = {};
    const rawCustom = String(process.env.LLM_CUSTOM_PROVIDERS || '').trim();
    if (rawCustom) {
      try {
        custom = JSON.parse(rawCustom);
      } catch {
        throw new Error('LLM_CUSTOM_PROVIDERS must be a JSON object of custom providers');
      }
    }
    const override = (process.env.LLM_PROVIDER_ORDER || '').trim().toLowerCase();
    const order = override ? override.split(',').map((s) => s.trim()) : undefined;
    return new LLMCascade({
      ...options,
      keys: { ...keys, ...(options.keys || {}) },
      baseUrls: { ...baseUrls, ...(options.baseUrls || {}) },
      custom: { ...custom, ...(options.custom || {}) },
      order: order || options.order,
      cloudflareAccountId: options.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID,
    });
  }

  /**
   * De-duplicated provider list restricted to providers we hold a key for.
   * Own-property check, not `this.keys[p]?.length`: an `order` built from a
   * request body could name `constructor` (Object.prototype.constructor has
   * a `.length`), which would otherwise pass the filter and show up as a
   * phantom failed attempt.
   */
  _withKeys(order) {
    return [...new Set(order)].filter((p) => typeof p === 'string' && Object.hasOwn(this.keys, p) && this.keys[p].length);
  }

  /** Scrubs the keys this instance holds, then anything else that looks like a credential. */
  _redact(message) {
    return redact(message, this._secrets);
  }

  /** Cooldown-filtered view of an arbitrary provider list (used for both the instance's default order and a per-call `order` override). */
  async _liveOrderFor(order) {
    const now = Date.now();
    const store = this.cooldownStore;
    // One round-trip for the whole chain when the store supports it (Redis
    // MGET etc.); otherwise N parallel gets.
    const untils = typeof store.getMany === 'function'
      ? await store.getMany(order)
      : await Promise.all(order.map((p) => store.get(p)));
    const live = order.filter((p, i) => (untils?.[i] || 0) <= now);
    const chain = live.length ? live : order; // never starve to zero
    return this.adaptiveOrder ? this._adaptiveSort(chain) : chain;
  }

  async _liveOrder() {
    return this._liveOrderFor(this.order);
  }

  /** Public, stable view of the provider chain as of right now (skips anything currently on cooldown). */
  getLiveOrder() {
    return this._liveOrder();
  }

  /**
   * Manually clear a provider's cooldown early — e.g. after your own
   * out-of-band health check confirms it's back online, rather than waiting
   * out the rest of `cooldownMs`. Also forgets that provider's per-key and
   * per-model cooldowns and its failure streak. A no-op if it wasn't cooling.
   * @param {string} provider
   */
  async clearCooldown(provider) {
    await this.cooldownStore.set(provider, 0);
    for (const key of [...this._cool.keys()]) {
      if (key.startsWith(`k:${provider}:`) || key.startsWith(`m:${provider}:`) || key.startsWith(`s:${provider}:`)) this._cool.delete(key);
    }
    this._transient.delete(provider);
  }

  /**
   * @param {string} provider
   * @param {string[]} stillLive - providers in this call's chain not yet cooled down (re-used instead of re-querying the store per failure).
   * @param {number} ms - how long to cool it.
   * @returns {Promise<boolean>} whether a cooldown was recorded.
   */
  async _coolDown(provider, stillLive, ms) {
    if (!stillLive.some((p) => p !== provider)) return false; // it's all we have — keep trying it
    await this.cooldownStore.set(provider, Date.now() + ms);
    if (typeof this.onProviderCooldown === 'function') {
      try { this.onProviderCooldown(provider, ms); } catch { /* observability hook — never break the cascade */ }
    }
    return true;
  }

  /** How long a failed provider should sit out: its keys/models' real recovery time for 429s, `cooldownMs` for structural faults. */
  _providerCooldownMs(err) {
    if (isRateLimitFailure(err.message)) {
      if (this._rateLimitPinned) return this.rateLimitCooldownMs;
      return clampCooldown(err.recoverInMs) ?? this.rateLimitCooldownMs;
    }
    return this.cooldownMs;
  }

  _runResolver(provider) {
    if (typeof this.modelResolver === 'function') {
      try {
        const resolved = this.modelResolver(provider);
        if (resolved && typeof resolved === 'string') return resolved;
      } catch { /* fall through to the static map */ }
    }
    return undefined;
  }

  /** Resolves the model for a provider via modelResolver (if set), falling back to the static map. A throwing/empty resolver is never fatal. */
  _resolveModel(provider) {
    return this._runResolver(provider) || this.models[provider];
  }

  /** The ordered models to try for a provider: a live resolver result or a pinned string is used alone; otherwise an explicit list, else defaultModel + fallbackModels. */
  _modelsFor(provider) {
    const resolved = this._runResolver(provider);
    if (resolved) return [resolved];
    if (this._modelLists[provider]) return this._modelLists[provider];
    if (this._pinned.has(provider)) return [this.models[provider]];
    const meta = this._meta[provider];
    return [...new Set([this.models[provider], ...(meta?.fallbackModels || [])].filter(Boolean))];
  }

  // ---- per-key / per-model cooldown bookkeeping --------------------------

  _slotUntil(provider, { keyIndex, model }) {
    return Math.max(
      this._cool.get(`k:${provider}:${keyIndex}`) || 0,
      this._cool.get(`m:${provider}:${model}`) || 0,
      this._cool.get(`s:${provider}:${keyIndex}:${model}`) || 0
    );
  }

  /** Every (key, model) combination for a provider: best model first, keys rotated so successive calls start on different keys. */
  _slotsFor(provider, models, keyCount) {
    const start = (this._rr.get(provider) || 0) % keyCount;
    this._rr.set(provider, start + 1);
    const slots = [];
    for (const model of models) {
      for (let j = 0; j < keyCount; j++) slots.push({ keyIndex: (start + j) % keyCount, model });
    }
    return slots;
  }

  _dayResetMs(provider) {
    const rule = this._meta[provider]?.dayReset;
    if (typeof rule === 'string' && rule.startsWith('midnight:')) return msUntilMidnight(rule.slice('midnight:'.length));
    return ROLLING_DAY_RECHECK_MS;
  }

  /** How long a rate-limited key+model should sit out. */
  _slotRateCooldownMs(provider, err) {
    if (this._rateLimitPinned) return this.rateLimitCooldownMs;
    const hinted = clampCooldown(err.retryAfterMs) ?? retryHintFromMessage(err.message);
    if (hinted) return hinted;
    const window = rateWindow(err.message);
    if (window === 'day') return this._dayResetMs(provider);
    if (window === 'minute') return 60 * 1000;
    return this.rateLimitCooldownMs;
  }

  _coolSlot(provider, slot, kind, err) {
    const now = Date.now();
    if (kind === 'rate') {
      this._cool.set(`s:${provider}:${slot.keyIndex}:${slot.model}`, now + this._slotRateCooldownMs(provider, err));
    } else if (kind === 'auth') {
      this._cool.set(`k:${provider}:${slot.keyIndex}`, now + this.cooldownMs);
    } else if (kind === 'model') {
      this._cool.set(`m:${provider}:${slot.model}`, now + this.cooldownMs);
    }
  }

  // ---- stats -------------------------------------------------------------

  _statsFor(provider) {
    let s = this._stats.get(provider);
    if (!s) {
      s = {
        calls: 0, ok: 0, failures: 0, rateLimited: 0, timeouts: 0,
        ewmaMs: null, samples: [], recent: [],
        tokens: { prompt: 0, completion: 0, total: 0 },
        lastError: null, lastErrorAt: null, lastSuccessAt: null,
        models: new Map(), keys: new Map(),
      };
      this._stats.set(provider, s);
    }
    return s;
  }

  _recordAttempt(provider, slot, { ok, ms, kind, error, usage }) {
    const now = Date.now();
    const s = this._statsFor(provider);
    const bump = (map, id) => {
      let e = map.get(id);
      if (!e) { e = { calls: 0, ok: 0, rateLimited: 0 }; map.set(id, e); }
      e.calls++;
      if (ok) e.ok++;
      else if (kind === 'rate') e.rateLimited++;
    };
    bump(s.models, slot.model);
    bump(s.keys, slot.keyIndex);
    s.calls++;
    s.recent.push(ok);
    if (s.recent.length > 20) s.recent.shift();
    if (ok) {
      s.ok++;
      s.lastSuccessAt = now;
      s.ewmaMs = s.ewmaMs == null ? ms : s.ewmaMs * 0.7 + ms * 0.3;
      s.samples.push(ms);
      if (s.samples.length > LATENCY_SAMPLES) s.samples.shift();
      if (usage) {
        s.tokens.prompt += usage.promptTokens || 0;
        s.tokens.completion += usage.completionTokens || 0;
        s.tokens.total += usage.totalTokens || 0;
      }
    } else {
      s.failures++;
      if (kind === 'rate') s.rateLimited++;
      if (/timed out/i.test(error || '')) s.timeouts++;
      s.lastError = error;
      s.lastErrorAt = now;
    }
    if (typeof this.onAttempt === 'function') {
      try {
        this.onAttempt({ provider, model: slot.model, keyIndex: slot.keyIndex, ok, ms, kind, error, at: now });
      } catch { /* observability hook — never break the cascade */ }
    }
  }

  /** Providers with enough samples are sorted by (latency / success rate) among the positions they already occupy within a same-tier run; the rest keep their place. */
  _adaptiveSort(chain) {
    const score = (provider) => {
      const s = this._stats.get(provider);
      if (!s || s.recent.length < 3 || s.ewmaMs == null) return null;
      const successRate = s.recent.filter(Boolean).length / s.recent.length;
      return s.ewmaMs / Math.max(successRate, 0.1);
    };
    const tier = (provider) => this._meta[provider]?.tier ?? 3;
    const out = [...chain];
    let i = 0;
    while (i < out.length) {
      let j = i;
      while (j < out.length && tier(out[j]) === tier(out[i])) j++;
      const positions = [];
      const scored = [];
      for (let k = i; k < j; k++) {
        const sc = score(out[k]);
        if (sc != null) { positions.push(k); scored.push({ provider: out[k], sc }); }
      }
      scored.sort((a, b) => a.sc - b.sc);
      positions.forEach((pos, n) => { out[pos] = scored[n].provider; });
      i = j;
    }
    return out;
  }

  /**
   * A snapshot of what the cascade has done since this instance was created:
   * per provider, the calls / successes / 429s / timeouts, latency (EWMA, p50,
   * p95), tokens, last error, per-model and per-key breakdowns (keys appear by
   * index only), the provider's remaining cooldown, and when it next becomes
   * usable. In-process only — a second process has its own numbers.
   */
  async stats() {
    const now = Date.now();
    const providers = {};
    for (const provider of Object.keys(this.keys)) {
      const s = this._stats.get(provider);
      const keyCount = this.keys[provider].length;
      const models = this._modelsFor(provider);
      const providerUntil = Number(await this.cooldownStore.get(provider)) || 0;
      const sorted = s ? [...s.samples].sort((a, b) => a - b) : [];
      const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

      const keys = [];
      for (let keyIndex = 0; keyIndex < keyCount; keyIndex++) {
        const e = s?.keys.get(keyIndex) || { calls: 0, ok: 0, rateLimited: 0 };
        const until = Math.max(...models.map((model) => this._slotUntil(provider, { keyIndex, model })));
        keys.push({ index: keyIndex, ...e, cooldownMs: Math.max(0, until - now) });
      }
      const modelStats = {};
      for (const model of models) {
        const e = s?.models.get(model) || { calls: 0, ok: 0, rateLimited: 0 };
        const until = Math.min(...Array.from({ length: keyCount }, (_, keyIndex) => this._slotUntil(provider, { keyIndex, model })));
        modelStats[model] = { ...e, cooldownMs: Math.max(0, until - now) };
      }
      const slotUntils = models.flatMap((model) => Array.from({ length: keyCount }, (_, keyIndex) => this._slotUntil(provider, { keyIndex, model })));
      const allSpentUntil = Math.min(...slotUntils);
      const nextUsableAt = Math.max(providerUntil, allSpentUntil, now);

      providers[provider] = {
        tier: this._meta[provider].tier ?? 3,
        keyCount,
        calls: s?.calls || 0,
        ok: s?.ok || 0,
        failures: s?.failures || 0,
        rateLimited: s?.rateLimited || 0,
        timeouts: s?.timeouts || 0,
        latencyMs: { ewma: s?.ewmaMs == null ? null : Math.round(s.ewmaMs), p50: pct(0.5), p95: pct(0.95) },
        tokens: s ? { ...s.tokens } : { prompt: 0, completion: 0, total: 0 },
        lastError: s?.lastError || null,
        lastErrorAt: s?.lastErrorAt || null,
        lastSuccessAt: s?.lastSuccessAt || null,
        providerCooldownMs: Math.max(0, providerUntil - now),
        usableInMs: nextUsableAt - now,
        keys,
        models: modelStats,
      };
    }
    return { since: this._startedAt, uptimeMs: now - this._startedAt, providers };
  }

  /**
   * Sends one tiny request through every configured key of every provider in
   * `providers` (default: the whole chain), one at a time, and reports who
   * answered. Catches revoked keys and retired default models before a user
   * does. It spends a little real quota per key; it never changes cooldowns.
   * @param {{providers?: string[], timeoutMs?: number, maxTokens?: number}} [options]
   * @returns {Promise<{provider: string, keyIndex: number, model: string, ok: boolean, ms: number, status: (number|null), message: (string|null)}[]>}
   */
  async probe(options = {}) {
    const providers = options.providers ? this._withKeys(options.providers) : this.order;
    const timeoutMs = resolveTimeout(options.timeoutMs ?? 15000);
    const opts = {
      system: 'You are a health check. Reply with the single word: ok',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: resolveMaxTokens(options.maxTokens ?? 32, this.maxTokensLimit),
      noThinking: true,
      timeoutMs,
      attemptTimeoutMs: timeoutMs,
      appName: this.appName,
      referer: this.referer,
      cloudflareAccountId: this.cloudflareAccountId,
    };
    const results = [];
    for (const provider of providers) {
      const model = this._modelsFor(provider)[0];
      for (let keyIndex = 0; keyIndex < this.keys[provider].length; keyIndex++) {
        const started = Date.now();
        try {
          const { usage } = await callProviderWithKey(provider, this._meta[provider], opts, this.keys[provider][keyIndex], model);
          const ms = Date.now() - started;
          this._recordAttempt(provider, { keyIndex, model }, { ok: true, ms, usage });
          results.push({ provider, keyIndex, model, ok: true, ms, status: 200, message: null });
        } catch (err) {
          const ms = Date.now() - started;
          const message = this._redact(err.message);
          this._recordAttempt(provider, { keyIndex, model }, { ok: false, ms, kind: classifyFailure(err.message), error: message });
          const status = /\bHTTP (\d{3})\b/.exec(err.message)?.[1];
          results.push({ provider, keyIndex, model, ok: false, ms, status: status ? Number(status) : null, message });
        }
      }
    }
    return results;
  }

  // ---- the cascade -------------------------------------------------------

  /**
   * Runs `run(apiKey, model)` against a provider, walking its key × model
   * slots until one works:
   *  - slots are tried best model first, and within a model the keys are
   *    rotated so successive calls start on different keys;
   *  - a slot on cooldown (spent a moment ago) is skipped without a request;
   *  - a 429 spends only that key+model, a 401/403 that key, a dead model
   *    that model — then the next slot is tried;
   *  - if every slot is cooling, the one that recovers soonest is tried anyway
   *    (so the last provider standing is never starved);
   *  - a request-specific failure (prompt too long) is rethrown immediately,
   *    tagged `requestSpecific`, so the caller doesn't cool the provider for it.
   */
  async _tryProvider(provider, run) {
    const keys = this.keys[provider] || [];
    if (!keys.length) throw new Error(`${provider}: no API key configured`);
    const slots = this._slotsFor(provider, this._modelsFor(provider), keys.length);

    let ready = slots.filter((slot) => this._slotUntil(provider, slot) <= Date.now());
    const forced = ready.length === 0;
    if (forced) ready = [slots.reduce((a, b) => (this._slotUntil(provider, b) < this._slotUntil(provider, a) ? b : a))];

    let lastErr;
    for (const slot of ready) {
      // An earlier failure in this loop may have cooled this slot's model or key.
      if (!forced && this._slotUntil(provider, slot) > Date.now()) continue;
      const started = Date.now();
      try {
        const result = await run(keys[slot.keyIndex], slot.model);
        this._recordAttempt(provider, slot, { ok: true, ms: Date.now() - started, usage: result?.usage });
        return result;
      } catch (err) {
        lastErr = err;
        const kind = classifyFailure(err.message);
        this._recordAttempt(provider, slot, { ok: false, ms: Date.now() - started, kind, error: this._redact(err.message) });
        if (kind === 'request') {
          err.requestSpecific = true;
          throw err;
        }
        if (kind === 'fatal') throw err;
        this._coolSlot(provider, slot, kind, err);
      }
    }

    if (lastErr && classifyFailure(lastErr.message) === 'rate') {
      const soonest = Math.min(...slots.map((slot) => this._slotUntil(provider, slot)));
      lastErr.recoverInMs = soonest - Date.now();
    }
    throw lastErr || new Error(`${provider}: no usable key`);
  }

  /** Starts a stream on one key+model and pulls its FIRST chunk, so a provider that fails immediately still falls over (see _tryProvider). */
  async _openStream(provider, opts, apiKey, model) {
    const gen = streamProviderWithKey(provider, this._meta[provider], opts, apiKey, model);
    const first = await gen.next();
    // Mirrors the non-streaming "returned an empty response" — without
    // this an empty stream would count as success and block fallback.
    if (first.done) throw new Error(`${provider} returned an empty response`);
    return {
      provider,
      stream: (async function* () {
        // If the consumer breaks out right after this already-buffered
        // first chunk, execution never reaches `yield* gen` below, so a
        // bare `yield first.value` would leave `gen` (and the SSE reader
        // inside it) never told to close. The explicit finally guarantees
        // cleanup propagates into `gen` regardless of which yield point
        // the consumer abandons the stream at.
        try {
          yield first.value;
          yield* gen;
        } finally {
          if (typeof gen.return === 'function') {
            try { await gen.return(); } catch { /* best-effort cleanup */ }
          }
        }
      })(),
    };
  }

  /**
   * Shared cascade loop: tries `attempt(provider, attemptTimeoutMs)` down the
   * live chain, redacting/reporting/cooling-down on failure, until one
   * succeeds or all have failed. `attemptTimeoutMs` is the per-attempt
   * timeout shrunk to whatever is left of `deadlineMs`, so the whole call —
   * not just each attempt — is bounded.
   *
   * On success, `attempt`'s resolved object is returned with an `attempts`
   * field spliced in: the (redacted) failures of every provider tried
   * *before* the winner, for callers who want to see/log the fallback path
   * without wrapping `generate()` themselves.
   */
  async _runCascade(chain, attempt, timeoutFor) {
    const failures = [];
    const hasDeadline = Number.isFinite(this.deadlineMs) && this.deadlineMs > 0;
    const deadline = hasDeadline ? Date.now() + this.deadlineMs : Infinity;
    // Shrinks as providers are cooled down during this call, so the last one
    // standing is never cooled (there'd be nothing left for the next call).
    let stillLive = chain;

    for (const provider of chain) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LLMCascadeError(
          `Deadline of ${this.deadlineMs}ms exceeded after ${failures.length} provider(s). ${describe(failures)}`,
          504,
          'DEADLINE_EXCEEDED',
          failures
        );
      }
      try {
        const result = await attempt(provider, Math.min(timeoutFor(provider), remaining));
        this._transient.delete(provider);
        return { ...result, attempts: failures };
      } catch (err) {
        const message = this._redact(err.message);
        failures.push({ provider, message });
        if (typeof this.onProviderFailure === 'function') {
          try { this.onProviderFailure(provider, message); } catch { /* observability hook — never break the cascade */ }
        }
        let ms;
        if (!err.requestSpecific && isProviderLevelFailure(err.message)) {
          ms = this._providerCooldownMs(err);
        } else if (!err.requestSpecific && isTransientFailure(err.message)) {
          const streak = (this._transient.get(provider) || 0) + 1;
          this._transient.set(provider, streak);
          if (streak >= BREAKER_THRESHOLD && this.breakerMs > 0) ms = this.breakerMs;
        }
        if (ms != null && await this._coolDown(provider, stillLive, ms)) {
          stillLive = stillLive.filter((p) => p !== provider);
          this._transient.delete(provider);
        }
      }
    }

    const allRateLimited = failures.every((f) => f.message.includes('429'));
    throw new LLMCascadeError(
      `All providers failed. ${describe(failures)}`,
      allRateLimited ? 429 : 502,
      allRateLimited ? 'ALL_RATE_LIMITED' : 'ALL_PROVIDERS_FAILED',
      failures
    );
  }

  /**
   * Run a chat completion across the provider chain until one succeeds.
   * @param {Object} params
   * @param {string} params.system - system prompt
   * @param {string} [params.user] - single-turn user message. Ignored if `messages` is given; one of the two is required.
   * @param {{role: 'user'|'assistant', content: string}[]} [params.messages] - full conversation history, for multi-turn calls. Takes precedence over `user` when both are given.
   * @param {boolean} [params.json] - request a JSON response (provider-native JSON mode where available)
   * @param {number} [params.maxTokens] - clamped to the instance's `maxTokensLimit` if one is set
   * @param {boolean} [params.noThinking] - Gemini only: disables "thinking" (`thinkingConfig: { thinkingBudget: 0 }`) for deterministic/structured calls that don't need it and would otherwise risk MAX_TOKENS. Ignored by every other provider.
   * @param {(text: string) => any} [params.parse] - if given, a provider whose output fails this is treated as a failure and the cascade moves on (ignored when `stream` is true)
   * @param {number} [params.timeoutMs] - per-attempt fetch timeout override for this call (also beats `providerTimeoutMs`)
   * @param {string[]} [params.order] - override the provider chain for just this call (providers without a configured key are dropped; falls back to the instance's default order if empty/omitted).
   * @param {boolean} [params.stream] - return `{ stream, provider }` (an async iterable of text chunks) instead of `{ text, ... }`. A provider that fails before its first chunk still falls over to the next one; once a chunk has been yielded there's no further fallback.
   * @returns {Promise<{text: string, parsed: any, provider: string, usage: ({promptTokens: number, completionTokens: number, totalTokens: number}|undefined), shadowCostUsd: (number|undefined), attempts: {provider: string, message: string}[]} | {stream: AsyncIterable<string>, provider: string, attempts: {provider: string, message: string}[]}>}
   */
  async generate(params) {
    const messages = normalizeMessages(params);

    const requestedOrder = Array.isArray(params.order) && params.order.length
      ? this._withKeys(params.order)
      : this.order;
    const chain = await this._liveOrderFor(requestedOrder);
    if (!chain.length) {
      throw new LLMCascadeError(
        `No provider is configured. Pass at least one key in "keys", or set an env var: ${Object.values(PROVIDER_ENV).join(', ')}.`,
        503,
        null
      );
    }

    const callTimeout = resolveTimeout(params.timeoutMs ?? this.timeoutMs);
    const timeoutFor = (provider) => {
      if (params.timeoutMs != null) return callTimeout;
      const own = Object.hasOwn(this.providerTimeoutMs, provider) ? this.providerTimeoutMs[provider] : undefined;
      return Number.isFinite(own) && own > 0 ? own : callTimeout;
    };
    const opts = {
      ...params,
      messages,
      maxTokens: resolveMaxTokens(params.maxTokens, this.maxTokensLimit),
      appName: this.appName,
      referer: this.referer,
      cloudflareAccountId: this.cloudflareAccountId,
      timeoutMs: callTimeout,
    };

    if (opts.stream) {
      return this._runCascade(
        chain,
        (provider, attemptTimeoutMs) => this._tryProvider(provider, (apiKey, model) => this._openStream(provider, { ...opts, attemptTimeoutMs }, apiKey, model)),
        timeoutFor
      );
    }

    return this._runCascade(chain, async (provider, attemptTimeoutMs) => {
      const { text, usage } = await this._tryProvider(provider, (apiKey, model) => (
        callProviderWithKey(provider, this._meta[provider], { ...opts, attemptTimeoutMs }, apiKey, model)
      ));
      const parsed = typeof opts.parse === 'function' ? opts.parse(text) : undefined;
      const costPerMillionTokens = this._meta[provider]?.costPerMillionTokens;
      const shadowCostUsd = usage?.totalTokens != null && costPerMillionTokens != null
        ? (usage.totalTokens / 1e6) * costPerMillionTokens
        : undefined;
      return { text, parsed, provider, usage, shadowCostUsd };
    }, timeoutFor);
  }
}

function describe(failures) {
  return failures.map((f) => `${f.provider}: ${f.message}`).join(' | ');
}

module.exports = {
  LLMCascade,
  LLMCascadeError,
  parseJsonLoose,
  redact,
  ALL_PROVIDERS,
  DEFAULT_MODELS,
  // { [provider]: { envVar, signupUrl, freeTierNotes, tier, limits, … } } — every
  // provider this package knows about, straight from providers.json, so a host
  // app (or the `keys` CLI) can build a "get more free keys" UI without
  // duplicating the data.
  PROVIDER_INFO: PROVIDERS_META,
  // Exposed for tests and for hosts that want to reuse the same parsing.
  _internals: { classifyFailure, parseDurationMs, retryHintFromMessage, rateWindow, msUntilMidnight, validateBaseUrl },
};
