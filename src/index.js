/**
 * llm-free-cascade
 *
 * Calls a chat-completion-shaped LLM across a chain of providers, trying the
 * next one whenever the current one is rate-limited, out of quota, or errors.
 * Every provider it knows about has (or had, at time of writing) a free tier —
 * the point is to stack several free accounts instead of paying for one.
 *
 * Supported providers: gemini, groq, cerebras, sambanova, mistral, openrouter,
 * together, deepseek, cohere, huggingface, cloudflare, anthropic (paid,
 * intended as a last-resort tier rather than a free one).
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

class LLMCascadeError extends Error {
  constructor(message, statusCode = 502, code = null) {
    super(message);
    this.name = 'LLMCascadeError';
    this.statusCode = statusCode;
    this.code = code;
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

async function extractErrorDetail(res) {
  try {
    const body = await res.json();
    return body?.error?.message || body?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// Strips anything that looks like a credential out of a provider error
// message before it's logged or surfaced — a provider can echo a key
// fragment back in its own error body.
function redact(message) {
  return String(message)
    .replace(/\b(api[ _-]?key|authorization|bearer)\b(\s*[:=]?\s*)[A-Za-z0-9._-]{8,}/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

function stripFences(text) {
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
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

async function callGemini({ system, user, json, maxTokens, apiKey, model }) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens || 1024 },
  };
  if (json) body.generationConfig.responseMimeType = 'application/json';

  const url = `${PROVIDERS_META.gemini.baseUrl}/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`gemini network error: ${err.message}`);
  }
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${await extractErrorDetail(res)}`);

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason;
    throw new Error(`gemini returned no content${reason ? ` (${reason})` : ''}`);
  }
  return text;
}

/** Shared OpenAI-compatible caller (Groq, Cerebras, SambaNova, Mistral, OpenRouter, Together, DeepSeek, Cohere, HF, Cloudflare). */
async function callOpenAICompat({ system, user, json, maxTokens, baseUrl, model, apiKey, provider, extraHeaders }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens || 1024,
  };
  if (json) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`${provider} network error: ${err.message}`);
  }
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${await extractErrorDetail(res)}`);

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error(`${provider} returned an empty response`);
  return text;
}

async function callAnthropic({ system, user, json, schema, maxTokens, apiKey, model }) {
  const body = { model, max_tokens: maxTokens || 1024, system, messages: [{ role: 'user', content: user }] };
  if (json && schema) body.output_config = { format: { type: 'json_schema', schema } };

  let res;
  try {
    res = await fetch(PROVIDERS_META.anthropic.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`anthropic network error: ${err.message}`);
  }
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${await extractErrorDetail(res)}`);

  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('anthropic returned an empty response');
  return text;
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
    let baseUrl = meta.baseUrl;
    if (provider === 'cloudflare') {
      if (!opts.cloudflareAccountId) return Promise.reject(new Error('cloudflare: cloudflareAccountId is required'));
      baseUrl = `https://api.cloudflare.com/client/v4/accounts/${opts.cloudflareAccountId}/ai/v1`;
    }
    const extraHeaders = meta.extraHeaders
      ? { 'HTTP-Referer': opts.referer || 'https://github.com', 'X-Title': opts.appName || 'llm-free-cascade' }
      : undefined;
    return callOpenAICompat({ ...opts, baseUrl, model, apiKey, provider, extraHeaders });
  }

  return Promise.reject(new Error(`${provider}: unknown apiStyle "${meta.apiStyle}"`));
}

/**
 * @typedef {Object} LLMCascadeOptions
 * @property {Object<string,string|string[]>} keys - provider -> API key(s). A provider with no key is skipped.
 * @property {string[]} [order] - provider order to try. Defaults to all providers that have a key, in registry order.
 * @property {Object<string,string>} [models] - provider -> model name override.
 * @property {string} [cloudflareAccountId] - required only if using the cloudflare provider.
 * @property {number} [cooldownMs=600000] - how long to skip a provider after a structural failure.
 * @property {string} [appName] - sent as OpenRouter's X-Title header.
 * @property {string} [referer] - sent as OpenRouter's HTTP-Referer header.
 * @property {(provider: string) => (string|null|undefined)} [modelResolver] - called before every attempt to resolve a live model override (e.g. from a DB/admin panel); falls back to `models[provider]` when it returns null/undefined or throws.
 * @property {(provider: string, message: string) => void} [onProviderFailure] - called once per failed provider, before the cooldown decision.
 * @property {(provider: string, cooldownMs: number) => void} [onProviderCooldown] - called when a provider is put on cooldown.
 */
class LLMCascade {
  /** @param {LLMCascadeOptions} options */
  constructor(options = {}) {
    this.models = { ...DEFAULT_MODELS, ...(options.models || {}) };
    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this.appName = options.appName;
    this.referer = options.referer;
    this.cloudflareAccountId = options.cloudflareAccountId;
    this.modelResolver = options.modelResolver;
    this.onProviderFailure = options.onProviderFailure;
    this.onProviderCooldown = options.onProviderCooldown;
    this.cooldownUntil = new Map();

    const rawKeys = options.keys || {};
    this.keys = {};
    for (const provider of ALL_PROVIDERS) {
      const v = rawKeys[provider];
      if (!v) continue;
      this.keys[provider] = Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
    }

    this.order = (options.order || ALL_PROVIDERS).filter((p) => this.keys[p]?.length);
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

  _liveOrder() {
    const now = Date.now();
    const live = this.order.filter((p) => (this.cooldownUntil.get(p) || 0) <= now);
    return live.length ? live : this.order; // never starve to zero
  }

  /** Public, stable view of the provider chain as of right now (skips anything currently on cooldown). */
  getLiveOrder() {
    return this._liveOrder();
  }

  _coolDown(provider) {
    const stillLive = this._liveOrder().filter((p) => p !== provider);
    if (!stillLive.length) return; // it's all we have — keep trying it
    this.cooldownUntil.set(provider, Date.now() + this.cooldownMs);
    if (typeof this.onProviderCooldown === 'function') {
      try { this.onProviderCooldown(provider, this.cooldownMs); } catch { /* observability hook — never break the cascade */ }
    }
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
   * Run a chat completion across the provider chain until one succeeds.
   * @param {Object} params
   * @param {string} params.system - system prompt
   * @param {string} params.user - user message
   * @param {boolean} [params.json] - request a JSON response (provider-native JSON mode where available)
   * @param {number} [params.maxTokens]
   * @param {(text: string) => any} [params.parse] - if given, a provider whose output fails this is treated as a failure and the cascade moves on
   * @returns {Promise<{text: string, parsed: any, provider: string}>}
   */
  async generate(params) {
    const chain = this._liveOrder();
    if (!chain.length) {
      throw new LLMCascadeError(
        `No provider is configured. Pass at least one key in "keys", or set an env var: ${Object.values(PROVIDER_ENV).join(', ')}.`,
        503
      );
    }

    const opts = { ...params, appName: this.appName, referer: this.referer, cloudflareAccountId: this.cloudflareAccountId };
    const failures = [];
    for (const provider of chain) {
      try {
        const text = await this._callProvider(provider, opts);
        const parsed = typeof opts.parse === 'function' ? opts.parse(text) : undefined;
        return { text, parsed, provider };
      } catch (err) {
        const message = redact(err.message);
        failures.push({ provider, message });
        if (typeof this.onProviderFailure === 'function') {
          try { this.onProviderFailure(provider, message); } catch { /* observability hook — never break the cascade */ }
        }
        if (isProviderLevelFailure(err.message)) this._coolDown(provider);
      }
    }

    const allRateLimited = failures.every((f) => f.message.includes('429'));
    throw new LLMCascadeError(
      `All providers failed. ${failures.map((f) => `${f.provider}: ${f.message}`).join(' | ')}`,
      allRateLimited ? 429 : 502,
      allRateLimited ? 'ALL_RATE_LIMITED' : 'ALL_PROVIDERS_FAILED'
    );
  }
}

module.exports = { LLMCascade, LLMCascadeError, parseJsonLoose, redact, ALL_PROVIDERS, DEFAULT_MODELS };
