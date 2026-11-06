/**
 * llm-free-cascade
 *
 * Calls a chat-completion-shaped LLM across a chain of providers, trying the
 * next one whenever the current one is rate-limited, out of quota, or errors.
 * Every provider it knows about has (or had, at time of writing) a free tier —
 * the point is to stack several free accounts instead of paying for one.
 *
 * The supported providers are listed in providers.json. DeepSeek and Anthropic
 * are paid, and intended as a last-resort tier rather than a free one.
 *
 * Zero dependencies — uses global fetch (Node 18+).
 */

'use strict';

// Single source of truth for provider metadata (base URL, default model, env
// var, free-tier notes). A contributor fixing a retired model name or adding
// a new free-tier provider only needs to touch this JSON file, not the
// dispatch logic below. See CONTRIBUTING.md.
const PROVIDERS_META = require('./providers.json');
const { fileCooldownStore, discoverFreeModels } = require('./extras.js');
const {
  ROLLING_DAY_RECHECK_MS,
  LLMCascadeError,
  CONTEXT_RE,
  classifyFailure,
  isTransientFailure,
  parseDurationMs,
  clampCooldown,
  retryHintFromMessage,
  rateWindow,
  msUntilMidnight,
  validateBaseUrl,
  isProviderLevelFailure,
  isRateLimitFailure,
  resolveTimeout,
  resolveMaxTokens,
} = require('./failures.js');
const {
  redact,
  parseJsonLoose,
  normalizeMessages,
  invalidInput,
  callProviderWithKey,
  streamProviderWithKey,
} = require('./transport.js');

const DEFAULT_MODELS = Object.fromEntries(
  Object.entries(PROVIDERS_META).map(([provider, meta]) => [provider, meta.defaultModel])
);

const ALL_PROVIDERS = Object.keys(PROVIDERS_META);

// provider -> env var name, used only by fromEnv()
const PROVIDER_ENV = Object.fromEntries(
  Object.entries(PROVIDERS_META).map(([provider, meta]) => [provider, meta.envVar])
);

// Circuit breaker: this many consecutive timeouts / network errors / 5xx in a
// row from one provider benches it for `breakerMs` instead of paying the full
// timeout again on every call.
const BREAKER_THRESHOLD = 2;
const DEFAULT_BREAKER_MS = 60 * 1000;
const MAX_BREAKER_MS = 15 * 60 * 1000;
const LATENCY_SAMPLES = 50;
// Reasoning models spend tokens on reasoning before any text, so a very low limit reads as an empty response.
const PROBE_MAX_TOKENS = 256;
// A context-length error is only trusted this long: limits and models change.
const LEARNED_CONTEXT_MS = 60 * 60 * 1000;
// Sent as the bearer token by a `keyless` custom provider (Ollama and the like ignore it).
const NO_KEY = 'no-key-required';
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FORBIDDEN_CUSTOM_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'host', 'x-api-key', 'x-goog-api-key']);

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
      contextTokens: Number.isFinite(c.contextTokens) && c.contextTokens > 0 ? c.contextTokens : undefined,
      signupUrl: null,
      freeTierNotes: 'custom provider',
      custom: true,
    };
    const supplied = c.apiKeys ?? c.apiKey ?? (c.keyless === true ? NO_KEY : undefined);
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
 * @property {Object<string,number>} [contextTokens] - provider -> context window in tokens. A provider the prompt plus `maxTokens` would not fit in is skipped without a request, unless nothing fits. The prompt size is a rough estimate (characters / 4).
 * @property {boolean} [sticky=false] - try the provider that last succeeded first, so a conversation stays on one provider while it keeps working.
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
    this.contextTokens = options.contextTokens || {};
    this._learnedContext = new Map();
    this.sticky = Boolean(options.sticky);
    this._lastGood = null;
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
    this._breakerTrips = new Map();
    this._localCooldown = new Map(); // used only for a cooldown the shared store failed to record
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
    this._secrets = Object.values(this.keys).flat().filter((k) => k !== NO_KEY);
    for (const m of Object.values(meta)) {
      if (m.custom) this._secrets.push(...Object.values(m.headers).filter((v) => v.length >= 8));
    }

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
   * Build a cascade straight from process.env: GEMINI_API_KEY, GEMINI_API_KEY_2..9, GROQ_API_KEY, etc.
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
    const cooldownFile = String(process.env.LLM_CASCADE_COOLDOWN_FILE || '').trim();
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
      ...(cooldownFile ? { cooldownStore: fileCooldownStore(cooldownFile) } : {}),
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
    let untils;
    try {
      untils = typeof store.getMany === 'function'
        ? await store.getMany(order)
        : await Promise.all(order.map((p) => store.get(p)));
    } catch {
      untils = []; // a broken shared store must not take the fallback chain down with it
    }
    const live = order.filter((p, i) => Math.max(untils?.[i] || 0, this._localCooldown.get(p) || 0) <= now);
    const chain = live.length ? live : order; // never starve to zero
    const sorted = this.adaptiveOrder ? this._adaptiveSort(chain) : chain;
    if (this.sticky && sorted.includes(this._lastGood)) {
      return [this._lastGood, ...sorted.filter((p) => p !== this._lastGood)];
    }
    return sorted;
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
    this._localCooldown.delete(provider);
    this._breakerTrips.delete(provider);
    try { await this.cooldownStore.set(provider, 0); } catch { /* store unavailable; local state is cleared */ }
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
    try {
      await this.cooldownStore.set(provider, Date.now() + ms);
    } catch {
      this._localCooldown.set(provider, Date.now() + ms);
    }
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
      let storedUntil = 0;
      try { storedUntil = Number(await this.cooldownStore.get(provider)) || 0; } catch { /* store unavailable */ }
      const providerUntil = Math.max(storedUntil, this._localCooldown.get(provider) || 0);
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
      maxTokens: resolveMaxTokens(options.maxTokens ?? PROBE_MAX_TOKENS, this.maxTokensLimit),
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
  async _tryProvider(provider, run, { timeoutMs, deadline = Infinity, signal } = {}) {
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
      const left = deadline - Date.now();
      if (left <= 0) break; // _runCascade reports DEADLINE_EXCEEDED
      const started = Date.now();
      try {
        const result = await run(keys[slot.keyIndex], slot.model, Math.min(timeoutMs ?? left, left));
        this._recordAttempt(provider, slot, { ok: true, ms: Date.now() - started, usage: result?.usage });
        return { ...result, model: slot.model };
      } catch (err) {
        if (signal?.aborted) throw err; // the caller gave up; this says nothing about the provider
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
    const info = { usage: undefined, finishReason: undefined };
    const gen = streamProviderWithKey(provider, this._meta[provider], { ...opts, info }, apiKey, model);
    const record = () => {
      const u = info.usage;
      if (!u) return;
      const tokens = this._statsFor(provider).tokens;
      tokens.prompt += u.promptTokens || 0;
      tokens.completion += u.completionTokens || 0;
      tokens.total += u.totalTokens || 0;
    };
    const first = await gen.next();
    // Mirrors the non-streaming "returned an empty response" — without
    // this an empty stream would count as success and block fallback.
    if (first.done) throw new Error(`${provider} returned an empty response`);
    return {
      provider,
      info,
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
          record();
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
  async _runCascade(chain, attempt, timeoutFor, signal, { deadlineAt, promptTokens } = {}) {
    const failures = [];
    const hasDeadline = Number.isFinite(this.deadlineMs) && this.deadlineMs > 0;
    const deadline = deadlineAt ?? (hasDeadline ? Date.now() + this.deadlineMs : Infinity);
    // Shrinks as providers are cooled down during this call, so the last one
    // standing is never cooled (there'd be nothing left for the next call).
    let stillLive = chain;
    const aborted = () => new LLMCascadeError('The call was aborted by the caller.', 499, 'ABORTED', failures);
    const pastDeadline = () => new LLMCascadeError(
      `Deadline of ${this.deadlineMs}ms exceeded after ${failures.length} provider(s). ${describe(failures)}`,
      504,
      'DEADLINE_EXCEEDED',
      failures
    );

    for (const provider of chain) {
      if (signal?.aborted) throw aborted();
      if (deadline - Date.now() <= 0) throw pastDeadline();
      try {
        const result = await attempt(provider, { timeoutMs: timeoutFor(provider), deadline, signal });
        this._transient.delete(provider);
        this._breakerTrips.delete(provider);
        this._lastGood = provider;
        return { ...result, attempts: failures };
      } catch (err) {
        if (signal?.aborted) throw aborted();
        const message = this._redact(err.message);
        failures.push({ provider, message });
        if (err.requestSpecific && promptTokens && CONTEXT_RE.test(err.message)) this._learnContext(provider, promptTokens);
        if (typeof this.onProviderFailure === 'function') {
          try { this.onProviderFailure(provider, message); } catch { /* observability hook — never break the cascade */ }
        }
        let ms;
        if (!err.requestSpecific && isProviderLevelFailure(err.message)) {
          ms = this._providerCooldownMs(err);
        } else if (!err.requestSpecific && isTransientFailure(err.message)) {
          const streak = (this._transient.get(provider) || 0) + 1;
          this._transient.set(provider, streak);
          if (streak >= BREAKER_THRESHOLD && this.breakerMs > 0) {
            // Doubles each time it trips again without a success in between.
            const trips = this._breakerTrips.get(provider) || 0;
            this._breakerTrips.set(provider, trips + 1);
            ms = Math.min(this.breakerMs * 2 ** trips, MAX_BREAKER_MS);
          }
        }
        if (ms != null && await this._coolDown(provider, stillLive, ms)) {
          stillLive = stillLive.filter((p) => p !== provider);
          this._transient.delete(provider);
        }
      }
    }

    if (deadline - Date.now() <= 0) throw pastDeadline();
    const allRateLimited = failures.every((f) => /\bHTTP 429\b/.test(f.message));
    throw new LLMCascadeError(
      `All providers failed. ${describe(failures)}`,
      allRateLimited ? 429 : 502,
      allRateLimited ? 'ALL_RATE_LIMITED' : 'ALL_PROVIDERS_FAILED',
      failures
    );
  }

  _learnContext(provider, promptTokens) {
    const known = this._learnedContext.get(provider);
    const stale = !known || Date.now() - known.at > LEARNED_CONTEXT_MS;
    this._learnedContext.set(provider, { tokens: stale ? promptTokens : Math.min(known.tokens, promptTokens), at: Date.now() });
  }

  /** Drops providers this prompt can't fit. If that would drop all of them, keeps the chain as it was. */
  _fitContext(chain, promptTokens, maxTokens) {
    const fits = (provider) => {
      const own = Object.hasOwn(this.contextTokens, provider) ? this.contextTokens[provider] : this._meta[provider]?.contextTokens;
      if (Number.isFinite(own) && own > 0 && promptTokens + maxTokens > own) return false;
      const learned = this._learnedContext.get(provider);
      return !(learned && Date.now() - learned.at <= LEARNED_CONTEXT_MS && promptTokens >= learned.tokens);
    };
    const fitted = chain.filter(fits);
    return fitted.length ? fitted : chain;
  }

  /** Wraps a stream so that a failure after text was sent moves on to the rest of the chain, telling the caller through `onRestart`. */
  _withRestart(first, chain, run, { onRestart, signal }) {
    const self = this;
    const result = { ...first };
    let current = first;
    result.stream = (async function* () {
      while (true) {
        try {
          yield* current.stream;
          return;
        } catch (err) {
          if (signal?.aborted) throw err;
          const from = current.provider;
          const error = self._redact(err.message);
          result.attempts.push({ provider: from, message: error });
          if (typeof self.onProviderFailure === 'function') {
            try { self.onProviderFailure(from, error); } catch { /* observability hook */ }
          }
          const rest = chain.slice(chain.indexOf(from) + 1);
          if (!rest.length) throw err;
          let next;
          try { next = await run(rest); } catch { throw err; }
          try { onRestart({ from, to: next.provider, error }); } catch { /* the caller's hook must not break the stream */ }
          result.attempts.push(...next.attempts);
          Object.assign(result, { provider: next.provider, model: next.model, info: next.info });
          current = next;
        }
      }
    })();
    return result;
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
   * @param {(event: {from: string, to: string, error: string}) => void} [params.onRestart] - streams only: if a stream fails after text was sent, try the rest of the chain and call this first, so you can discard the partial answer. Without it, the failure rejects the stream.
   * @returns {Promise<{text: string, parsed: any, provider: string, usage: ({promptTokens: number, completionTokens: number, totalTokens: number}|undefined), shadowCostUsd: (number|undefined), attempts: {provider: string, message: string}[]} | {stream: AsyncIterable<string>, provider: string, attempts: {provider: string, message: string}[]}>}
   */
  async generate(params) {
    const messages = normalizeMessages(params);
    if (params.system != null && typeof params.system !== 'string') throw invalidInput('"system" must be a string');
    if (params.onRestart != null && typeof params.onRestart !== 'function') throw invalidInput('"onRestart" must be a function');
    if (params.signal?.aborted) throw new LLMCascadeError('The call was aborted by the caller.', 499, 'ABORTED');
    const stop = params.stop == null ? undefined : [].concat(params.stop);
    if (stop && (!stop.length || !stop.every((s) => typeof s === 'string' && s))) throw invalidInput('"stop" must be a non-empty string or array of strings');
    for (const name of ['temperature', 'topP', 'seed']) {
      if (params[name] != null && !Number.isFinite(params[name])) throw invalidInput(`"${name}" must be a number`);
    }

    const requestedOrder = Array.isArray(params.order) && params.order.length
      ? this._withKeys(params.order)
      : this.order;
    const liveChain = await this._liveOrderFor(requestedOrder);
    if (!liveChain.length) {
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
      stop,
      maxTokens: resolveMaxTokens(params.maxTokens, this.maxTokensLimit),
      appName: this.appName,
      referer: this.referer,
      cloudflareAccountId: this.cloudflareAccountId,
      timeoutMs: callTimeout,
    };

    const promptTokens = Math.ceil(([params.system || '', ...messages.map((m) => m.content)].join('').length) / 4);
    const chain = this._fitContext(liveChain, promptTokens, opts.maxTokens);
    const hasDeadline = Number.isFinite(this.deadlineMs) && this.deadlineMs > 0;
    const budgetInfo = { promptTokens, deadlineAt: hasDeadline ? Date.now() + this.deadlineMs : Infinity };

    if (opts.stream) {
      const run = (providers) => this._runCascade(
        providers,
        (provider, budget) => this._tryProvider(provider, (apiKey, model, attemptTimeoutMs) => this._openStream(provider, { ...opts, attemptTimeoutMs }, apiKey, model), budget),
        timeoutFor,
        params.signal,
        budgetInfo
      );
      const first = await run(chain);
      return typeof params.onRestart === 'function' ? this._withRestart(first, chain, run, params) : first;
    }

    return this._runCascade(chain, async (provider, budget) => {
      const { text, usage, finishReason, model } = await this._tryProvider(provider, (apiKey, model, attemptTimeoutMs) => (
        callProviderWithKey(provider, this._meta[provider], { ...opts, attemptTimeoutMs }, apiKey, model)
      ), budget);
      const parsed = typeof opts.parse === 'function' ? opts.parse(text) : undefined;
      const costPerMillionTokens = this._meta[provider]?.costPerMillionTokens;
      const shadowCostUsd = usage?.totalTokens != null && costPerMillionTokens != null
        ? (usage.totalTokens / 1e6) * costPerMillionTokens
        : undefined;
      return { text, parsed, provider, model, finishReason, usage, shadowCostUsd };
    }, timeoutFor, params.signal, budgetInfo);
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
  fileCooldownStore,
  discoverFreeModels,
  // Exposed for tests and for hosts that want to reuse the same parsing.
  _internals: { classifyFailure, parseDurationMs, retryHintFromMessage, rateWindow, msUntilMidnight, validateBaseUrl },
};
