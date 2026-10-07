'use strict';

// Tests for the reset-aware / per-key / per-model cascade (v0.9): slot
// rotation, Retry-After, error classification, circuit breaker, custom
// providers, stats and probe. Like cascade.test.js, no real network calls.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LLMCascade, PROVIDER_INFO, ALL_PROVIDERS, _internals } = require('../src/index.js');

const okRes = (content = 'hi', usage) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) });
const errRes = (status, message, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  json: async () => ({ error: { message } }),
});

/** Installs a fake fetch that records every call and answers with `handler({url, body, key, n})`. Restores itself after the test. */
function fakeFetch(t, handler) {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const calls = [];
  global.fetch = async (url, init) => {
    const call = {
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
      key: String(init?.headers?.authorization || '').replace('Bearer ', ''),
      headers: init?.headers || {},
      n: calls.length + 1,
    };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

const sseRes = (chunks) => {
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(`data: ${x === '[DONE]' ? x : JSON.stringify({ choices: [{ delta: { content: x } }] })}\n\n`));
        c.close();
      },
    }),
  };
};

// ---------------------------------------------------------------------------
// providers.json
// ---------------------------------------------------------------------------

test('providers.json: every provider has a tier, a fallbackModels array, and a plain-https signupUrl', () => {
  for (const provider of ALL_PROVIDERS) {
    const info = PROVIDER_INFO[provider];
    assert.ok(Number.isInteger(info.tier) && info.tier >= 1 && info.tier <= 5, `${provider} tier`);
    assert.ok(Array.isArray(info.fallbackModels), `${provider} fallbackModels`);
    assert.match(info.signupUrl, /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\/-]*)?$/, `${provider} signupUrl must be CLI-safe`);
    if (info.baseUrl) assert.match(info.baseUrl, /^https:\/\//, `${provider} baseUrl must be https`);
  }
});

test('providers.json is sorted by tier, so the default order is fast-and-roomy first and paid last', () => {
  const tiers = ALL_PROVIDERS.map((p) => PROVIDER_INFO[p].tier);
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
  assert.equal(ALL_PROVIDERS.at(-1), 'anthropic');
  const keys = Object.fromEntries(ALL_PROVIDERS.map((p) => [p, 'k']));
  assert.deepEqual(new LLMCascade({ keys }).order, ALL_PROVIDERS);
});

// ---------------------------------------------------------------------------
// duration / window parsing
// ---------------------------------------------------------------------------

test('parseDurationMs understands Retry-After seconds and Gemini/Groq style durations', () => {
  const { parseDurationMs, retryHintFromMessage, rateWindow } = _internals;
  assert.equal(parseDurationMs('7'), 7000);
  assert.equal(parseDurationMs('33.1s'), 33100);
  assert.equal(parseDurationMs('2m59.52s'), 179520);
  assert.equal(parseDurationMs('250ms'), 250);
  assert.equal(parseDurationMs('1h2m'), 3720000);
  assert.equal(parseDurationMs('soon'), undefined);
  assert.equal(retryHintFromMessage('Rate limit reached. Please try again in 2m59.5s.'), 179500);
  assert.equal(retryHintFromMessage('quota exceeded. Please retry in 33.1s'), 33100);
  assert.equal(retryHintFromMessage('retry after 20 seconds'), 20000);
  assert.equal(retryHintFromMessage('something else'), undefined);
  assert.equal(rateWindow('Rate limit reached on tokens per day (TPD)'), 'day');
  assert.equal(rateWindow('limit: requests per minute (RPM)'), 'minute');
  assert.equal(rateWindow('rate limited'), null);
});

test('msUntilMidnight counts to the next local midnight in the given zone', () => {
  const { msUntilMidnight } = _internals;
  assert.equal(msUntilMidnight('UTC', new Date('2026-10-07T23:00:00Z')), 3600 * 1000 + 1000);
  // 06:30Z on Oct 7 is 23:30 in Los Angeles (PDT, UTC-7): 30 minutes to go.
  assert.equal(msUntilMidnight('America/Los_Angeles', new Date('2026-10-07T06:30:00Z')), 30 * 60 * 1000 + 1000);
  assert.equal(msUntilMidnight('Not/AZone'), 60 * 60 * 1000); // unusable zone -> one hour
});

test('classifyFailure separates request-specific, rate, auth, model and fatal failures', () => {
  const { classifyFailure } = _internals;
  assert.equal(classifyFailure('cloudflare HTTP 400: maximum context length is 8192 tokens'), 'request');
  assert.equal(classifyFailure('groq HTTP 413: request too large'), 'request');
  assert.equal(classifyFailure('groq HTTP 429: Rate limit reached'), 'rate');
  assert.equal(classifyFailure('gemini HTTP 403: quota exceeded'), 'rate');
  assert.equal(classifyFailure('groq HTTP 401: invalid api key'), 'auth');
  assert.equal(classifyFailure('groq HTTP 404: The model `x` does not exist'), 'model');
  assert.equal(classifyFailure('groq HTTP 400: bad model'), 'fatal');
  assert.equal(classifyFailure('groq HTTP 500: boom'), 'fatal');
});

// ---------------------------------------------------------------------------
// per-key and per-model slots
// ---------------------------------------------------------------------------

test('keys rotate round-robin, so successive calls start on different keys', async (t) => {
  const calls = fakeFetch(t, () => okRes());
  const cascade = new LLMCascade({ keys: { groq: ['k1', 'k2'] }, order: ['groq'], models: { groq: 'm' } });
  for (let i = 0; i < 4; i++) await cascade.generate({ system: 's', user: 'u' });
  assert.deepEqual(calls.map((c) => c.key), ['k1', 'k2', 'k1', 'k2']);
});

test('a rate-limited key is skipped on later calls instead of costing a request every time', async (t) => {
  const calls = fakeFetch(t, ({ key }) => (key === 'k1' ? errRes(429, 'rate limit', { 'retry-after': '60' }) : okRes()));
  const cascade = new LLMCascade({ keys: { groq: ['k1', 'k2'] }, order: ['groq'], models: { groq: 'm' } });
  for (let i = 0; i < 4; i++) await cascade.generate({ system: 's', user: 'u' });
  assert.equal(calls.filter((c) => c.key === 'k1').length, 1, 'k1 should be tried once, then rested');
  assert.equal(calls.filter((c) => c.key === 'k2').length, 4);
});

test('a 429 on the first model falls to the next model on the same provider before leaving it', async (t) => {
  const calls = fakeFetch(t, ({ body }) => (body.model === PROVIDER_INFO.groq.defaultModel ? errRes(429, 'rate limit') : okRes('from fallback model')));
  const cascade = new LLMCascade({ keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'] });
  const result = await cascade.generate({ system: 's', user: 'u' });
  assert.equal(result.provider, 'groq');
  assert.equal(result.text, 'from fallback model');
  assert.deepEqual(result.attempts, [], 'staying on the same provider is not a provider fallback');
  assert.deepEqual(calls.map((c) => c.body.model), [PROVIDER_INFO.groq.defaultModel, PROVIDER_INFO.groq.fallbackModels[0]]);
});

test('models: an array is an ordered list; a string pins exactly one model; a resolver is used alone', async (t) => {
  const calls = fakeFetch(t, ({ body }) => (body.model === 'a' ? errRes(429, 'rate limit') : okRes()));
  const list = new LLMCascade({ keys: { groq: 'k' }, order: ['groq'], models: { groq: ['a', 'b', 'a'] } });
  await list.generate({ system: 's', user: 'u' });
  assert.deepEqual(calls.map((c) => c.body.model), ['a', 'b']);

  calls.length = 0;
  const pinned = new LLMCascade({ keys: { groq: 'k' }, order: ['groq'], models: { groq: 'z' } });
  await pinned.generate({ system: 's', user: 'u' });
  assert.deepEqual(calls.map((c) => c.body.model), ['z']);

  calls.length = 0;
  const resolved = new LLMCascade({ keys: { groq: 'k' }, order: ['groq'], modelResolver: () => 'live' });
  await resolved.generate({ system: 's', user: 'u' });
  assert.deepEqual(calls.map((c) => c.body.model), ['live']);
});

test('a retired model (404) is dropped for every key and the next model is tried', async (t) => {
  const calls = fakeFetch(t, ({ body }) => (body.model === 'gone' ? errRes(404, 'The model `gone` does not exist') : okRes()));
  const cascade = new LLMCascade({ keys: { groq: ['k1', 'k2'] }, order: ['groq'], models: { groq: ['gone', 'alive'] } });
  await cascade.generate({ system: 's', user: 'u' });
  await cascade.generate({ system: 's', user: 'u' });
  assert.equal(calls.filter((c) => c.body.model === 'gone').length, 1, 'the retired model is tried once, not once per key per call');
});

test('when every slot is cooling, the soonest one is still tried (the last provider is never starved)', async (t) => {
  const calls = fakeFetch(t, () => errRes(429, 'rate limit', { 'retry-after': '60' }));
  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'], models: { groq: 'm' } });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  assert.equal(calls.length, 2);
});

test('streaming also falls over key/model slots before its first chunk', async (t) => {
  const calls = fakeFetch(t, ({ body }) => (body.model === 'a' ? errRes(429, 'rate limit') : sseRes(['he', 'llo', '[DONE]'])));
  const cascade = new LLMCascade({ keys: { groq: 'k' }, order: ['groq'], models: { groq: ['a', 'b'] } });
  const { stream, provider, attempts } = await cascade.generate({ system: 's', user: 'u', stream: true });
  let text = '';
  for await (const chunk of stream) text += chunk;
  assert.equal(provider, 'groq');
  assert.equal(text, 'hello');
  assert.deepEqual(attempts, []);
  assert.deepEqual(calls.map((c) => c.body.model), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// reset-aware provider cooldowns
// ---------------------------------------------------------------------------

test('Retry-After sets the cooldown of a rate-limited provider', async (t) => {
  fakeFetch(t, ({ url }) => (url.includes('groq') ? errRes(429, 'rate limit', { 'retry-after': '7' }) : okRes()));
  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' },
    onProviderCooldown: (p, ms) => cooled.push([p, ms]),
  });
  await cascade.generate({ system: 's', user: 'u' });
  assert.equal(cooled.length, 1);
  assert.equal(cooled[0][0], 'groq');
  assert.ok(cooled[0][1] > 6000 && cooled[0][1] <= 7000, `expected ~7000ms, got ${cooled[0][1]}`);
});

test('a "try again in 2m59.5s" hint inside the error text is honoured too', async (t) => {
  fakeFetch(t, ({ url }) => (url.includes('groq') ? errRes(429, 'Rate limit reached. Please try again in 2m59.5s.') : okRes()));
  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' },
    onProviderCooldown: (p, ms) => cooled.push([p, ms]),
  });
  await cascade.generate({ system: 's', user: 'u' });
  assert.ok(cooled[0][1] > 178000 && cooled[0][1] <= 179500);
});

test('a per-minute limit with no hint cools for a minute; a per-day limit waits for the reset', async (t) => {
  fakeFetch(t, ({ url }) => {
    if (url.includes('groq')) return errRes(429, 'limit reached on requests per minute (RPM)');
    if (url.includes('cerebras')) return errRes(429, 'limit reached on tokens per day (TPD)');
    return okRes();
  });
  const cooled = {};
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2', mistral: 'k3' }, order: ['groq', 'cerebras', 'mistral'],
    models: { groq: 'm', cerebras: 'm', mistral: 'm' },
    onProviderCooldown: (p, ms) => { cooled[p] = ms; },
  });
  await cascade.generate({ system: 's', user: 'u' });
  assert.equal(cooled.groq, 60 * 1000);
  assert.equal(cooled.cerebras, 60 * 60 * 1000, 'rolling daily window with no clock reset is re-checked hourly');
});

test('rateLimitCooldownMs, when set, pins the 429 cooldown and overrides hints', async (t) => {
  fakeFetch(t, ({ url }) => (url.includes('groq') ? errRes(429, 'rate limit', { 'retry-after': '500' }) : okRes()));
  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' },
    rateLimitCooldownMs: 1234, onProviderCooldown: (p, ms) => cooled.push([p, ms]),
  });
  await cascade.generate({ system: 's', user: 'u' });
  assert.deepEqual(cooled, [['groq', 1234]]);
});

// ---------------------------------------------------------------------------
// error classification in the cascade
// ---------------------------------------------------------------------------

test('a prompt that is too long for one provider skips it for this call but does not cool it', async (t) => {
  fakeFetch(t, ({ url }) => (url.includes('groq') ? errRes(400, 'This model\'s maximum context length is 8192 tokens') : okRes()));
  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' },
    onProviderCooldown: (p) => cooled.push(p),
  });
  const result = await cascade.generate({ system: 's', user: 'u' });
  assert.equal(result.provider, 'cerebras');
  assert.deepEqual(cooled, []);
  assert.deepEqual(await cascade.getLiveOrder(), ['groq', 'cerebras']);
});

test('circuit breaker: two timeouts/network errors in a row bench a provider, so later calls skip it', async (t) => {
  const calls = fakeFetch(t, ({ url }) => {
    if (url.includes('groq')) throw new Error('connect ETIMEDOUT');
    return okRes();
  });
  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' },
    breakerMs: 5000, onProviderCooldown: (p, ms) => cooled.push([p, ms]),
  });
  for (let i = 0; i < 4; i++) await cascade.generate({ system: 's', user: 'u' });
  assert.equal(calls.filter((c) => c.url.includes('groq')).length, 2, 'groq is tried twice, then benched');
  assert.deepEqual(cooled, [['groq', 5000]]);
});

test('breakerMs: 0 turns the circuit breaker off', async (t) => {
  const calls = fakeFetch(t, ({ url }) => {
    if (url.includes('groq')) throw new Error('connect ETIMEDOUT');
    return okRes();
  });
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' }, breakerMs: 0,
  });
  for (let i = 0; i < 4; i++) await cascade.generate({ system: 's', user: 'u' });
  assert.equal(calls.filter((c) => c.url.includes('groq')).length, 4);
});

test('a success resets the failure streak, so scattered blips never trip the breaker', async (t) => {
  let n = 0;
  const calls = fakeFetch(t, ({ url }) => {
    if (url.includes('groq') && ++n % 2 === 1) throw new Error('connect ETIMEDOUT');
    return okRes();
  });
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], models: { groq: 'm', cerebras: 'm' },
  });
  for (let i = 0; i < 6; i++) await cascade.generate({ system: 's', user: 'u' });
  assert.ok(calls.filter((c) => c.url.includes('groq')).length >= 4, 'groq stays in rotation');
});

// ---------------------------------------------------------------------------
// timeouts
// ---------------------------------------------------------------------------

test('providerTimeoutMs gives one provider its own timeout; a per-call timeoutMs still wins', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const cascade = new LLMCascade({ keys: { groq: 'k' }, order: ['groq'], models: { groq: 'm' }, providerTimeoutMs: { groq: 25 } });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }), /timed out after 25ms/);
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u', timeoutMs: 40 }), /timed out after 40ms/);
});

// ---------------------------------------------------------------------------
// custom providers & base URL overrides
// ---------------------------------------------------------------------------

test('custom providers: any OpenAI-compatible endpoint joins the chain, with its own key, model and headers', async (t) => {
  const calls = fakeFetch(t, () => okRes('via gateway'));
  const cascade = new LLMCascade({
    keys: {},
    custom: {
      omniroute: { baseUrl: 'http://localhost:20128/v1/', model: 'auto/best-free', apiKey: 'gw-key', headers: { 'X-Team': 'physics' } },
    },
  });
  assert.deepEqual(cascade.order, ['omniroute']);
  const result = await cascade.generate({ system: 's', user: 'u' });
  assert.equal(result.provider, 'omniroute');
  assert.equal(calls[0].url, 'http://localhost:20128/v1/chat/completions');
  assert.equal(calls[0].body.model, 'auto/best-free');
  assert.equal(calls[0].key, 'gw-key');
  assert.equal(calls[0].headers['X-Team'], 'physics');
});

test('custom providers are placed by tier and can be reordered like any other', () => {
  const cascade = new LLMCascade({
    keys: { groq: 'k', deepseek: 'k' },
    custom: { mine: { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k', tier: 1 } },
  });
  assert.deepEqual(cascade.order, ['groq', 'mine', 'deepseek']);
});

test('custom providers are validated: https only (localhost excepted), no shadowing, safe names and headers', () => {
  const ok = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' };
  assert.throws(() => new LLMCascade({ custom: { a: { ...ok, baseUrl: 'http://example.com/v1' } } }), /https/);
  assert.throws(() => new LLMCascade({ custom: { a: { ...ok, baseUrl: 'https://user:pw@example.com/v1' } } }), /credentials/);
  assert.throws(() => new LLMCascade({ custom: { a: { ...ok, baseUrl: 'not a url' } } }), /valid URL/);
  assert.throws(() => new LLMCascade({ custom: { groq: ok } }), /shadow/);
  assert.throws(() => new LLMCascade({ custom: { 'Bad Name': ok } }), /must match/);
  assert.throws(() => new LLMCascade({ custom: JSON.parse('{"__proto__": {"baseUrl": "https://example.com/v1", "model": "m"}}') }), /must match/);
  assert.throws(() => new LLMCascade({ custom: { a: { baseUrl: ok.baseUrl, apiKey: 'k' } } }), /model/);
  assert.throws(() => new LLMCascade({ custom: { a: { ...ok, headers: { Authorization: 'Bearer x' } } } }), /not allowed/);
  assert.throws(() => new LLMCascade({ custom: { a: { ...ok, headers: { 'X-A': 'x\r\nEvil: 1' } } } }), /invalid value/);
});

test('baseUrls re-points a built-in provider (e.g. the China Zhipu endpoint) without touching other instances', async (t) => {
  const calls = fakeFetch(t, () => okRes());
  const cn = new LLMCascade({ keys: { zhipu: 'k' }, baseUrls: { zhipu: 'https://open.bigmodel.cn/api/paas/v4' } });
  await cn.generate({ system: 's', user: 'u' });
  const intl = new LLMCascade({ keys: { zhipu: 'k' } });
  await intl.generate({ system: 's', user: 'u' });
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(calls[1].url, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.throws(() => new LLMCascade({ baseUrls: { nope: 'https://example.com' } }), /unknown provider/);
  assert.throws(() => new LLMCascade({ baseUrls: { groq: 'http://evil.example.com' } }), /https/);
});

test('fromEnv reads <PROVIDER>_BASE_URL and LLM_CUSTOM_PROVIDERS', async (t) => {
  const calls = fakeFetch(t, () => okRes());
  process.env.ZHIPU_API_KEY = 'zk';
  process.env.ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
  process.env.LLM_CUSTOM_PROVIDERS = JSON.stringify({ gw: { baseUrl: 'http://127.0.0.1:4000/v1', model: 'm', apiKey: 'gk' } });
  t.after(() => { delete process.env.ZHIPU_API_KEY; delete process.env.ZHIPU_BASE_URL; delete process.env.LLM_CUSTOM_PROVIDERS; });
  const cascade = LLMCascade.fromEnv();
  assert.deepEqual(cascade.order, ['zhipu', 'gw']);
  await cascade.generate({ system: 's', user: 'u', order: ['zhipu'] });
  assert.ok(calls[0].url.startsWith('https://open.bigmodel.cn/'));

  process.env.LLM_CUSTOM_PROVIDERS = '{not json';
  assert.throws(() => LLMCascade.fromEnv(), /LLM_CUSTOM_PROVIDERS/);
});

// ---------------------------------------------------------------------------
// observability
// ---------------------------------------------------------------------------

test('stats(): per provider, model and key counters, latency, tokens and cooldowns — and never a key', async (t) => {
  fakeFetch(t, ({ key }) => (key === 'secret-k1' ? errRes(429, 'rate limit', { 'retry-after': '30' }) : okRes('hi', { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 })));
  const cascade = new LLMCascade({ keys: { groq: ['secret-k1', 'secret-k2'] }, order: ['groq'], models: { groq: 'm' } });
  await cascade.generate({ system: 's', user: 'u' });
  await cascade.generate({ system: 's', user: 'u' });

  const stats = await cascade.stats();
  const groq = stats.providers.groq;
  assert.equal(groq.keyCount, 2);
  assert.equal(groq.calls, 3);
  assert.equal(groq.ok, 2);
  assert.equal(groq.rateLimited, 1);
  assert.deepEqual(groq.tokens, { prompt: 8, completion: 12, total: 20 });
  assert.equal(groq.keys[0].rateLimited, 1);
  assert.ok(groq.keys[0].cooldownMs > 0 && groq.keys[0].cooldownMs <= 30000);
  assert.equal(groq.keys[1].cooldownMs, 0);
  assert.equal(groq.models.m.calls, 3);
  assert.equal(typeof groq.latencyMs.p50, 'number');
  assert.ok(!JSON.stringify(stats).includes('secret-k'), 'key material must never appear in stats');
});

test('onAttempt fires for every key × model attempt, with redacted errors and no key material', async (t) => {
  fakeFetch(t, ({ key }) => (key === 'secret-k1' ? errRes(429, 'rate limit for key secret-k1') : okRes()));
  const seen = [];
  const cascade = new LLMCascade({
    keys: { groq: ['secret-k1', 'secret-k2'] }, order: ['groq'], models: { groq: 'm' },
    onAttempt: (a) => seen.push(a),
  });
  await cascade.generate({ system: 's', user: 'u' });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((a) => [a.keyIndex, a.ok, a.kind ?? null]), [[0, false, 'rate'], [1, true, null]]);
  assert.ok(!JSON.stringify(seen).includes('secret-k'));
  // a throwing hook never breaks the cascade
  const loud = new LLMCascade({ keys: { groq: 'k' }, order: ['groq'], models: { groq: 'm' }, onAttempt: () => { throw new Error('boom'); } });
  assert.equal((await loud.generate({ system: 's', user: 'u' })).text, 'hi');
});

test('adaptiveOrder moves the faster provider ahead within a tier, but only once there are enough samples', async () => {
  const keys = { groq: 'k1', cerebras: 'k2', deepseek: 'k3' }; // groq & cerebras are tier 1, deepseek tier 5
  const plain = new LLMCascade({ keys });
  const adaptive = new LLMCascade({ keys, adaptiveOrder: true });
  const feed = (c, provider, ms, n) => { for (let i = 0; i < n; i++) c._recordAttempt(provider, { keyIndex: 0, model: 'm' }, { ok: true, ms }); };

  feed(adaptive, 'groq', 900, 2);
  feed(adaptive, 'cerebras', 100, 2);
  assert.deepEqual(await adaptive.getLiveOrder(), ['groq', 'cerebras', 'deepseek'], 'too few samples: keep the listed order');

  feed(adaptive, 'groq', 900, 2);
  feed(adaptive, 'cerebras', 100, 2);
  assert.deepEqual(await adaptive.getLiveOrder(), ['cerebras', 'groq', 'deepseek'], 'faster provider first, paid provider stays last');

  feed(plain, 'groq', 900, 4);
  feed(plain, 'cerebras', 100, 4);
  assert.deepEqual(await plain.getLiveOrder(), ['groq', 'cerebras', 'deepseek'], 'off by default');
});

test('probe(): one tiny request per configured key, reporting who answered and who did not', async (t) => {
  const calls = fakeFetch(t, ({ key }) => (key === 'bad-key-123' ? errRes(401, 'invalid api key: bad-key-123') : okRes('ok')));
  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: ['good-key-1', 'bad-key-123'] }, order: ['groq'], models: { groq: 'm' },
    onProviderCooldown: (p) => cooled.push(p),
  });
  const results = await cascade.probe({ timeoutMs: 1000 });
  assert.equal(calls.length, 2);
  assert.deepEqual(results.map((r) => [r.provider, r.keyIndex, r.ok, r.status]), [['groq', 0, true, 200], ['groq', 1, false, 401]]);
  assert.ok(!JSON.stringify(results).includes('bad-key-123'), 'the key must be redacted from the report');
  assert.deepEqual(cooled, [], 'probing never changes cooldowns');
  assert.equal(calls[0].body.max_tokens, 32);
});

test('clearCooldown also forgets per-key and per-model cooldowns', async (t) => {
  const calls = fakeFetch(t, ({ n }) => (n === 1 ? errRes(429, 'rate limit', { 'retry-after': '60' }) : okRes()));
  const cascade = new LLMCascade({ keys: { groq: ['k1', 'k2'] }, order: ['groq'], models: { groq: 'm' } });
  await cascade.generate({ system: 's', user: 'u' }); // k1 429s, k2 serves
  await cascade.clearCooldown('groq');
  await cascade.generate({ system: 's', user: 'u' }); // rr cursor is on k2 now
  await cascade.generate({ system: 's', user: 'u' }); // ...and back to k1, which is usable again
  assert.deepEqual(calls.map((c) => c.key), ['k1', 'k2', 'k2', 'k1']);
});
