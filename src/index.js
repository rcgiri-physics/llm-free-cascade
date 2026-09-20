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

/** True if a failure should make us try the NEXT key for the same provider. */
function isKeyExhaustedError(message) {
  return /\b(401|403|429)\b/.test(message) || /quota|rate.?limit|exhaust|invalid.*key|api key/i.test(message);
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
    if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${await extractErrorDetail(res)}`);
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
    throw new Error(`HTTP ${res.status}: ${detail}`);
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
  const { apiKey, model, attemptTimeoutMs } = opts;
  const url = `${PROVIDERS_META.gemini.baseUrl}/${encodeURIComponent(model)}:generateContent`;
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
  const { apiKey, attemptTimeoutMs } = opts;
  const data = await fetchJson('anthropic', PROVIDERS_META.anthropic.baseUrl, {
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

/** Shared per-provider setup (Cloudflare's per-account base URL, OpenRouter's extra headers) used by both the non-streaming and streaming openai-compat callers. */
function resolveOpenAICompatTarget(provider, meta, opts) {
  let baseUrl = meta.baseUrl;
  if (provider === 'cloudflare') {
    const id = opts.cloudflareAccountId;
    if (!id) throw new Error('cloudflare: cloudflareAccountId is required');
    if (!CLOUDFLARE_ACCOUNT_ID_RE.test(String(id))) throw new Error('cloudflare: cloudflareAccountId must be a 32-character hex account ID');
    baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(id)}/ai/v1`;
  }
  const extraHeaders = meta.extraHeaders
    ? { 'HTTP-Referer': opts.referer || 'https://github.com', 'X-Title': opts.appName || 'llm-free-cascade' }
    : undefined;
  return { baseUrl, extraHeaders };
}

/**
 * Dispatches on each provider's `apiStyle` from providers.json instead of a
 * hardcoded per-provider switch, so adding a new OpenAI-compatible free-tier
 * provider is a JSON-only change (see CONTRIBUTING.md) — no code touched
 * unless the provider needs bespoke request/response handling like Gemini
 * and Anthropic do.
 */
function callProviderWithKey(provider, opts, apiKey, model) {
  const meta = PROVIDERS_META[provider];
  if (!meta) return Promise.reject(new Error(`unknown provider: ${provider}`));

  if (meta.apiStyle === 'gemini') return callGemini({ ...opts, apiKey, model });
  if (meta.apiStyle === 'anthropic') return callAnthropic({ ...opts, apiKey, model });

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
  const { apiKey, model } = opts;
  const url = `${PROVIDERS_META.gemini.baseUrl}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
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
    throw new Error(`gemini ${err.message}`);
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
    throw new Error(`${provider} ${err.message}`);
  }
}

async function* streamAnthropic(opts) {
  const { apiKey } = opts;
  try {
    for await (const payload of streamSSE(PROVIDERS_META.anthropic.baseUrl, {
      method: 'POST',
      headers: jsonHeaders({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
      body: JSON.stringify(anthropicBody({ ...opts, stream: true })),
    }, streamTimeouts(opts))) {
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') yield data.delta.text;
    }
  } catch (err) {
    throw new Error(`anthropic ${err.message}`);
  }
}

/** Streaming counterpart of callProviderWithKey — same apiStyle dispatch, returns an async generator of text chunks instead of a Promise. */
function streamProviderWithKey(provider, opts, apiKey, model) {
  const meta = PROVIDERS_META[provider];
  if (!meta) throw new Error(`unknown provider: ${provider}`);

  if (meta.apiStyle === 'gemini') return streamGemini({ ...opts, apiKey, model });
  if (meta.apiStyle === 'anthropic') return streamAnthropic({ ...opts, apiKey, model });

  if (meta.apiStyle === 'openai-compat') {
    const { baseUrl, extraHeaders } = resolveOpenAICompatTarget(provider, meta, opts);
    return streamOpenAICompat({ ...opts, baseUrl, model, apiKey, provider, extraHeaders });
  }

  throw new Error(`${provider}: unknown apiStyle "${meta.apiStyle}"`);
}

/**
 * @typedef {Object} LLMCascadeOptions
 * @property {Object<string,string|string[]>} keys - provider -> API key(s). A provider with no key is skipped.
 * @property {string[]} [order] - provider order to try. Defaults to all providers that have a key, in registry order. Duplicates are ignored.
 * @property {Object<string,string>} [models] - provider -> model name override.
 * @property {string} [cloudflareAccountId] - required only if using the cloudflare provider (32-char hex account ID).
 * @property {number} [cooldownMs=600000] - how long to skip a provider after a structural failure.
 * @property {number} [rateLimitCooldownMs] - how long to skip a provider after a rate-limit/quota failure (429) on its last key. Defaults to `cooldownMs`; set it lower when your providers' limits are per-minute rather than per-day.
 * @property {number} [deadlineMs] - total time budget for one `generate()` call across every provider it tries. Without it, the worst case is `timeoutMs` × (number of providers). Exceeding it throws an LLMCascadeError with code `DEADLINE_EXCEEDED`.
 * @property {number} [maxTokensLimit] - hard ceiling applied to every call's `maxTokens`, so a caller-supplied value can never exceed it (cost control when `maxTokens` comes from an untrusted request).
 * @property {string} [appName] - sent as OpenRouter's X-Title header.
 * @property {string} [referer] - sent as OpenRouter's HTTP-Referer header.
 * @property {number} [timeoutMs=30000] - default per-attempt fetch timeout (covers connect + headers + body); overridable per-call via `generate({ timeoutMs })`. For streams it's the time-to-first-byte and then an idle timeout re-armed after every chunk. A timeout is treated as a normal provider failure (cascade moves to the next provider). Non-positive/non-finite values fall back to the default.
 * @property {{get: (provider: string) => (number|Promise<number>), set: (provider: string, until: number) => (void|Promise<void>), getMany?: (providers: string[]) => (number[]|Promise<number[]>)}} [cooldownStore] - where cooldown timestamps live. Defaults to an in-memory Map (per-instance only); pass a shared store (e.g. Redis-backed) to coordinate cooldowns across processes/instances. An optional `getMany` lets a remote store answer for the whole chain in one round-trip.
 * @property {(provider: string) => (string|null|undefined)} [modelResolver] - called before every attempt to resolve a live model override (e.g. from a DB/admin panel); falls back to `models[provider]` when it returns null/undefined or throws.
 * @property {(provider: string, message: string) => void} [onProviderFailure] - called once per failed provider, before the cooldown decision.
 * @property {(provider: string, cooldownMs: number) => void} [onProviderCooldown] - called when a provider is put on cooldown.
 */
class LLMCascade {
  /** @param {LLMCascadeOptions} options */
  constructor(options = {}) {
    this.models = { ...DEFAULT_MODELS, ...(options.models || {}) };
    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? this.cooldownMs;
    this.deadlineMs = options.deadlineMs;
    this.maxTokensLimit = options.maxTokensLimit;
    this.appName = options.appName;
    this.referer = options.referer;
    this.cloudflareAccountId = options.cloudflareAccountId;
    this.modelResolver = options.modelResolver;
    this.onProviderFailure = options.onProviderFailure;
    this.onProviderCooldown = options.onProviderCooldown;
    this.timeoutMs = options.timeoutMs;
    // In-memory default; a caller can pass `cooldownStore` (e.g. backed by
    // Redis) to share cooldown state across processes/instances instead.
    const cooldownUntil = new Map();
    this.cooldownStore = options.cooldownStore || {
      get: (provider) => cooldownUntil.get(provider) || 0,
      set: (provider, until) => { cooldownUntil.set(provider, until); },
    };

    const rawKeys = options.keys || {};
    this.keys = {};
    for (const provider of ALL_PROVIDERS) {
      const v = rawKeys[provider];
      if (!v) continue;
      this.keys[provider] = Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
    }
    // Every key we hold, so redaction can scrub the literal value from any
    // provider error regardless of how the provider phrased it.
    this._secrets = Object.values(this.keys).flat();

    // De-duplicated: `order: ['groq', 'groq']` (easy to do via LLM_PROVIDER_ORDER)
    // would otherwise make the same provider fail twice per call.
    this.order = this._withKeys(options.order || ALL_PROVIDERS);
  }

  /**
   * Build a cascade straight from process.env, using the same var names
   * ai.service.js does: GEMINI_API_KEY, GEMINI_API_KEY_2..9, GROQ_API_KEY, etc.
   * A comma-separated primary var (`GEMINI_API_KEY=key1,key2`) also works.
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
    const override = (process.env.LLM_PROVIDER_ORDER || '').trim().toLowerCase();
    const order = override ? override.split(',').map((s) => s.trim()) : undefined;
    return new LLMCascade({
      ...options,
      keys: { ...keys, ...(options.keys || {}) },
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
    return live.length ? live : order; // never starve to zero
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
   * out the rest of `cooldownMs`. A no-op if it wasn't on cooldown.
   * @param {string} provider
   */
  async clearCooldown(provider) {
    await this.cooldownStore.set(provider, 0);
  }

  /**
   * @param {string} provider
   * @param {string[]} stillLive - providers in this call's chain not yet cooled down (re-used instead of re-querying the store per failure).
   * @param {string} message - the (raw) failure message, to pick the cooldown length.
   * @returns {Promise<boolean>} whether a cooldown was recorded.
   */
  async _coolDown(provider, stillLive, message) {
    if (!stillLive.some((p) => p !== provider)) return false; // it's all we have — keep trying it
    const ms = isRateLimitFailure(message) ? this.rateLimitCooldownMs : this.cooldownMs;
    await this.cooldownStore.set(provider, Date.now() + ms);
    if (typeof this.onProviderCooldown === 'function') {
      try { this.onProviderCooldown(provider, ms); } catch { /* observability hook — never break the cascade */ }
    }
    return true;
  }

  /** Resolves the model for a provider via modelResolver (if set), falling back to the static map. A throwing/empty resolver is never fatal. */
  _resolveModel(provider) {
    if (typeof this.modelResolver === 'function') {
      try {
        const resolved = this.modelResolver(provider);
        if (resolved) return resolved;
      } catch { /* fall through to the static map */ }
    }
    return this.models[provider];
  }

  async _callProvider(provider, opts) {
    const keys = this.keys[provider] || [];
    if (!keys.length) throw new Error(`${provider}: no API key configured`);
    const model = this._resolveModel(provider);
    let lastErr;
    for (let i = 0; i < keys.length; i++) {
      try {
        return await callProviderWithKey(provider, opts, keys[i], model);
      } catch (err) {
        lastErr = err;
        if (i < keys.length - 1 && isKeyExhaustedError(err.message)) continue;
        throw err;
      }
    }
    throw lastErr;
  }

  /**
   * Streaming counterpart of _callProvider. Pulls the FIRST chunk before
   * returning so a provider that fails immediately (bad key, HTTP error,
   * or a stream that closes without ever producing text) still participates
   * in fallback/key-rotation exactly like the non-streaming path — once a
   * first chunk is in hand, the rest of that provider's stream is handed to
   * the caller with no further fallback (there's no way to un-send partial
   * output already yielded).
   */
  async _startStream(provider, opts) {
    const keys = this.keys[provider] || [];
    if (!keys.length) throw new Error(`${provider}: no API key configured`);
    const model = this._resolveModel(provider);
    let lastErr;
    for (let i = 0; i < keys.length; i++) {
      const gen = streamProviderWithKey(provider, opts, keys[i], model);
      let first;
      try {
        first = await gen.next();
        // Mirrors the non-streaming "returned an empty response" — without
        // this an empty stream would count as success and block fallback.
        if (first.done) throw new Error(`${provider} returned an empty response`);
      } catch (err) {
        lastErr = err;
        if (i < keys.length - 1 && isKeyExhaustedError(err.message)) continue;
        throw err;
      }
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
    throw lastErr;
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
  async _runCascade(chain, attempt, timeoutMs) {
    const failures = [];
    const perAttemptMs = resolveTimeout(timeoutMs);
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
        const result = await attempt(provider, Math.min(perAttemptMs, remaining));
        return { ...result, attempts: failures };
      } catch (err) {
        const message = this._redact(err.message);
        failures.push({ provider, message });
        if (typeof this.onProviderFailure === 'function') {
          try { this.onProviderFailure(provider, message); } catch { /* observability hook — never break the cascade */ }
        }
        if (isProviderLevelFailure(err.message) && await this._coolDown(provider, stillLive, err.message)) {
          stillLive = stillLive.filter((p) => p !== provider);
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
   * @param {number} [params.timeoutMs] - per-attempt fetch timeout override for this call
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

    const timeoutMs = resolveTimeout(params.timeoutMs ?? this.timeoutMs);
    const opts = {
      ...params,
      messages,
      maxTokens: resolveMaxTokens(params.maxTokens, this.maxTokensLimit),
      appName: this.appName,
      referer: this.referer,
      cloudflareAccountId: this.cloudflareAccountId,
      timeoutMs,
    };

    if (opts.stream) {
      return this._runCascade(chain, (provider, attemptTimeoutMs) => this._startStream(provider, { ...opts, attemptTimeoutMs }), timeoutMs);
    }

    return this._runCascade(chain, async (provider, attemptTimeoutMs) => {
      const { text, usage } = await this._callProvider(provider, { ...opts, attemptTimeoutMs });
      const parsed = typeof opts.parse === 'function' ? opts.parse(text) : undefined;
      const costPerMillionTokens = PROVIDERS_META[provider]?.costPerMillionTokens;
      const shadowCostUsd = usage?.totalTokens != null && costPerMillionTokens != null
        ? (usage.totalTokens / 1e6) * costPerMillionTokens
        : undefined;
      return { text, parsed, provider, usage, shadowCostUsd };
    }, timeoutMs);
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
  // { [provider]: { envVar, signupUrl, freeTierNotes } } — every provider this
  // package knows about, straight from providers.json, so a host app (or the
  // `keys` CLI) can build a "get more free keys" UI without duplicating the data.
  PROVIDER_INFO: PROVIDERS_META,
};
