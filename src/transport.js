'use strict';

// Talking to providers: fetch and SSE handling, request bodies, response parsing.

const {
  LLMCascadeError,
  withRetry,
  prefixError,
  resolveTimeout,
  abortRejection,
  timeoutMessage,
} = require('./failures.js');

const ANTHROPIC_VERSION = '2023-06-01';
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
async function fetchJson(provider, url, options, timeoutMs, signal) {
  const controller = new AbortController();
  const ms = resolveTimeout(timeoutMs);
  const timer = setTimeout(() => controller.abort(), ms);
  const unlink = linkSignal(signal, controller);
  try {
    let res;
    try {
      res = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
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
    unlink();
  }
}

/** Aborts `controller` when the caller's `signal` fires. Returns the function that removes the link. */
function linkSignal(signal, controller) {
  if (!signal) return () => {};
  const onAbort = () => controller.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
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
async function* streamSSE(url, options, { firstByteMs, idleMs, signal }) {
  const controller = new AbortController();
  const connectMs = resolveTimeout(firstByteMs);
  const quietMs = resolveTimeout(idleMs);
  let timer = setTimeout(() => controller.abort(), connectMs);
  const unlink = linkSignal(signal, controller);
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), quietMs);
  };

  let res;
  try {
    res = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    unlink();
    throw new Error(`network error: ${timeoutMessage(err, connectMs)}`);
  }
  if (!res.ok) {
    const detail = await extractErrorDetail(res); // read while the timer is still armed
    clearTimeout(timer);
    unlink();
    throw withRetry(new Error(`HTTP ${res.status}: ${detail}`), res);
  }
  if (!res.body) {
    clearTimeout(timer);
    unlink();
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
      // The SSE spec allows CRLF. Normalizing the whole buffer also covers a
      // \r\n pair split across two chunks. A trailing \r waits for its \n.
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const payload of ssePayloads(rawEvent)) {
          if (payload === '[DONE]') return;
          yield payload;
        }
      }
      if (buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes without a boundary`);
      }
    }
    // A final event is valid without a trailing blank line.
    for (const payload of ssePayloads((buffer + decoder.decode()).replace(/\r\n/g, '\n'))) {
      if (payload === '[DONE]') return;
      yield payload;
    }
  } finally {
    reader.releaseLock();
    controller.abort(); // no-op if the stream already ended naturally
    clearTimeout(timer);
    unlink();
  }
}

function ssePayloads(rawEvent) {
  return rawEvent.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
}

/** The human-readable part of an error body, across the shapes providers use. */
function errorText(body) {
  const b = Array.isArray(body) ? body[0] : body;
  if (!b || typeof b !== 'object') return undefined;
  const candidates = [b.error?.message, b.error, b.message, b.detail, b.errors?.[0]?.message];
  return candidates.find((c) => typeof c === 'string' && c);
}

async function extractErrorDetail(res) {
  try {
    let body;
    let raw;
    if (typeof res.text === 'function') {
      raw = await res.text();
      try { body = JSON.parse(raw); } catch { /* not JSON: use the raw text */ }
    } else {
      body = await res.json();
    }
    const detail = errorText(body) || (body === undefined && raw ? raw.trim() : undefined);
    return detail ? String(detail).slice(0, MAX_ERROR_DETAIL_CHARS) : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** An error event sent inside an otherwise successful stream, as an Error the cascade can classify. */
function streamEventError(data) {
  if (!data?.error && data?.type !== 'error') return null;
  const detail = errorText(data) || 'stream error';
  const code = Number(data.error?.code ?? data.error?.status);
  const status = code >= 400 && code < 600 ? code : data.error?.type === 'overloaded_error' ? 529 : null;
  return new Error(status ? `HTTP ${status}: ${detail}` : `stream error: ${detail}`);
}

const GEMINI_FINISH = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', BLOCKLIST: 'content_filter', PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter' };
const ANTHROPIC_FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter', tool_use: 'tool_calls' };

/** OpenAI content is normally a string, but some providers return an array of parts. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
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
    .replace(/\bBearer[ \t]{1,4}[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|gsk|csk|nvapi|hf)[-_][A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{30,}/g, '[redacted]');
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
    if (!MESSAGE_ROLES.has(m.role)) throw invalidInput(`messages[${i}].role must be "user" or "assistant''}`);
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

const finite = (n) => Number.isFinite(n);

function geminiBody({ system, messages, json, maxTokens, noThinking, temperature, topP, stop, seed }) {
  const body = {
    // Gemini's wire format calls the assistant turn "model", not "assistant".
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (finite(temperature)) body.generationConfig.temperature = temperature;
  if (finite(topP)) body.generationConfig.topP = topP;
  if (stop) body.generationConfig.stopSequences = stop;
  if (finite(seed)) body.generationConfig.seed = seed;
  if (json) body.generationConfig.responseMimeType = 'application/json';
  // gemini-2.5-flash "thinks" by default, spending the output budget on
  // reasoning before any JSON — which can starve short structured calls into
  // MAX_TOKENS. `noThinking` disables it for deterministic/classification
  // tasks that don't benefit from it.
  if (noThinking) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return body;
}

function openAICompatBody({ system, messages, json, maxTokens, model, stream, temperature, topP, stop, seed }) {
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    max_tokens: maxTokens,
  };
  if (finite(temperature)) body.temperature = temperature;
  if (finite(topP)) body.top_p = topP;
  if (stop) body.stop = stop;
  if (finite(seed)) body.seed = seed;
  if (json) body.response_format = { type: 'json_object' };
  if (stream) body.stream = true;
  return body;
}

function anthropicBody({ system, messages, json, schema, maxTokens, model, stream, temperature, topP, stop }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (finite(temperature)) body.temperature = temperature;
  if (finite(topP)) body.top_p = topP;
  if (stop) body.stop_sequences = stop;
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
  }, attemptTimeoutMs, opts.signal);

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason;
    const err = new Error(`gemini returned no content${reason ? ` (${reason})` : ''}`);
    // A safety block is about this prompt. Gemini itself is fine.
    if (reason && reason !== 'MAX_TOKENS') err.requestSpecific = true;
    throw err;
  }
  const finish = candidate?.finishReason;
  return { text, usage: normalizeUsage(data.usageMetadata), finishReason: GEMINI_FINISH[finish] || (finish ? 'other' : undefined) };
}

/** Shared OpenAI-compatible caller (Groq, Mistral, OpenRouter, DeepSeek, Cohere, Cloudflare, ...). */
async function callOpenAICompat(opts) {
  const { baseUrl, apiKey, provider, extraHeaders, attemptTimeoutMs } = opts;
  const data = await fetchJson(provider, `${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders({ authorization: `Bearer ${apiKey}`, ...extraHeaders }),
    body: JSON.stringify(openAICompatBody(opts)),
  }, attemptTimeoutMs, opts.signal);

  const text = contentText(data.choices?.[0]?.message?.content).trim();
  if (!text) {
    const finish = data.choices?.[0]?.finish_reason;
    throw new Error(`${provider} returned an empty response${finish ? ` (finish_reason: ${finish})` : ''}`);
  }
  return { text, usage: normalizeUsage(data.usage), finishReason: data.choices?.[0]?.finish_reason || undefined };
}

async function callAnthropic(opts) {
  const { apiKey, attemptTimeoutMs, baseUrl } = opts;
  const data = await fetchJson('anthropic', baseUrl, {
    method: 'POST',
    headers: jsonHeaders({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
    body: JSON.stringify(anthropicBody(opts)),
  }, attemptTimeoutMs, opts.signal);

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('anthropic returned an empty response');
  return { text, usage: normalizeUsage(data.usage), finishReason: ANTHROPIC_FINISH[data.stop_reason] || (data.stop_reason ? 'other' : undefined) };
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

  return Promise.reject(new Error(`${provider}: unknown apiStyle "${meta.apiStyle}''}`));
}

const streamTimeouts = (opts) => ({ firstByteMs: opts.attemptTimeoutMs ?? opts.timeoutMs, idleMs: opts.timeoutMs, signal: opts.signal });

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
      const eventError = streamEventError(data);
      if (eventError) throw eventError;
      const finish = data.candidates?.[0]?.finishReason;
      if (finish && opts.info) opts.info.finishReason = GEMINI_FINISH[finish] || 'other';
      if (data.usageMetadata && opts.info) opts.info.usage = normalizeUsage(data.usageMetadata);
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
      const eventError = streamEventError(data);
      if (eventError) throw eventError;
      const finish = data.choices?.[0]?.finish_reason;
      if (finish && opts.info) opts.info.finishReason = finish;
      // Reported by the providers that include usage in a stream without being asked.
      const usage = data.usage || data.x_groq?.usage;
      if (usage && opts.info) opts.info.usage = normalizeUsage(usage);
      const delta = contentText(data.choices?.[0]?.delta?.content);
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
      const eventError = streamEventError(data);
      if (eventError) throw eventError;
      if (opts.info) {
        if (data.type === 'message_start' && data.message?.usage) opts.info.usage = normalizeUsage(data.message.usage);
        if (data.type === 'message_delta') {
          if (data.delta?.stop_reason) opts.info.finishReason = ANTHROPIC_FINISH[data.delta.stop_reason] || 'other';
          const output = data.usage?.output_tokens;
          if (output != null) {
            const prompt = opts.info.usage?.promptTokens;
            opts.info.usage = { promptTokens: prompt, completionTokens: output, totalTokens: prompt != null ? prompt + output : undefined };
          }
        }
      }
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

  throw new Error(`${provider}: unknown apiStyle "${meta.apiStyle}''}`);
}

module.exports = {
  redact,
  parseJsonLoose,
  normalizeMessages,
  invalidInput,
  callProviderWithKey,
  streamProviderWithKey,
};
