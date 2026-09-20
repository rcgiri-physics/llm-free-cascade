'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LLMCascade, parseJsonLoose, redact, PROVIDER_INFO, ALL_PROVIDERS } = require('../src/index.js');

test('throws when no provider is configured', async () => {
  const cascade = new LLMCascade({ keys: {} });
  await assert.rejects(
    () => cascade.generate({ system: 's', user: 'u' }),
    /No provider is configured/
  );
});

test('order filters to only providers with a key', async () => {
  const cascade = new LLMCascade({
    keys: { groq: 'k1', gemini: 'k2' },
    order: ['gemini', 'groq', 'cerebras'],
  });
  assert.deepEqual(await cascade._liveOrder(), ['gemini', 'groq']);
});

test('parseJsonLoose extracts JSON wrapped in markdown fences', () => {
  const text = '```json\n{"a": 1}\n```';
  assert.deepEqual(parseJsonLoose(text), { a: 1 });
});

test('parseJsonLoose extracts the first balanced JSON block from prose', () => {
  const text = 'Sure! Here you go: {"a": [1, 2, "}"]} — hope that helps.';
  assert.deepEqual(parseJsonLoose(text), { a: [1, 2, '}'] });
});

test('fromEnv reads comma-separated and numbered keys', () => {
  process.env.GEMINI_API_KEY = 'k1,k2';
  process.env.GEMINI_API_KEY_2 = 'k3'; // duplicate-safe: de-duped
  const cascade = LLMCascade.fromEnv();
  assert.deepEqual(cascade.keys.gemini.sort(), ['k1', 'k2', 'k3']);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY_2;
});

test('getLiveOrder is a public wrapper around the live provider chain', async () => {
  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  assert.deepEqual(await cascade.getLiveOrder(), ['groq']);
});

test('modelResolver overrides the static model when it returns a value', () => {
  const cascade = new LLMCascade({
    keys: { groq: 'k1' },
    modelResolver: (provider) => (provider === 'groq' ? 'resolved-model' : null),
  });
  assert.equal(cascade._resolveModel('groq'), 'resolved-model');
});

test('modelResolver falls back to the static map on null/undefined/throw', () => {
  const staticModel = 'static-model';
  for (const resolver of [() => null, () => undefined, () => { throw new Error('boom'); }]) {
    const cascade = new LLMCascade({ keys: { groq: 'k1' }, models: { groq: staticModel }, modelResolver: resolver });
    assert.equal(cascade._resolveModel('groq'), staticModel);
  }
});

test('redact strips API keys and bearer tokens from a message', () => {
  assert.equal(redact('groq HTTP 401: invalid api_key: sk-abcdefgh12345678'), 'groq HTTP 401: invalid api_key: [redacted]');
  assert.equal(redact('groq HTTP 401: invalid api key: sk-secretvalue123'), 'groq HTTP 401: invalid api key: [redacted]');
  assert.equal(redact('failed with Authorization: Bearer sk-abcdefgh12345678'), 'failed with Authorization: Bearer [redacted]');
  assert.equal(redact('plain error with no secret'), 'plain error with no secret');
});

test('onProviderFailure and onProviderCooldown fire with redacted messages', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key: sk-secretvalue123' } }) });

  const failures = [];
  const cooldowns = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1' },
    order: ['groq'],
    onProviderFailure: (provider, message) => failures.push({ provider, message }),
    onProviderCooldown: (provider, cooldownMs) => cooldowns.push({ provider, cooldownMs }),
  });

  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].provider, 'groq');
  assert.ok(!failures[0].message.includes('sk-secretvalue123'), 'secret should be redacted');
  // HTTP 401 *is* a provider-level failure, but a single-provider chain is never
  // cooled down (there would be nothing left to try) — see the two-provider test below.
  assert.equal(cooldowns.length, 0);
});

test('a slow provider times out and the cascade falls over to the next one', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    // never resolves on its own — only the abort should settle this promise
  });

  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' },
    order: ['groq', 'cerebras'],
    timeoutMs: 20,
  });
  await assert.rejects(
    () => cascade.generate({ system: 's', user: 'u' }),
    /timed out after 20ms/
  );
});

test('usage is normalized and threaded through to the result', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  const result = await cascade.generate({ system: 's', user: 'u' });
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test('usage is undefined when the provider does not report one', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) });

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  const result = await cascade.generate({ system: 's', user: 'u' });
  assert.equal(result.usage, undefined);
});

test('a custom cooldownStore is used instead of the in-memory default', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'HTTP 500: no content' } }) });

  const store = new Map();
  const cooldownStore = {
    get: (p) => store.get(p) || 0,
    set: (p, until) => { store.set(p, until); },
  };
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' },
    order: ['groq', 'cerebras'],
    cooldownStore,
  });

  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  assert.ok(store.get('groq') > Date.now(), 'cooldown should be recorded in the custom store');
});

/** Builds a fetch Response-alike whose body is an SSE stream of the given OpenAI-style delta chunks. */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const payload = chunk === '[DONE]' ? '[DONE]' : JSON.stringify({ choices: [{ delta: { content: chunk } }] });
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

async function collect(asyncIterable) {
  const out = [];
  for await (const chunk of asyncIterable) out.push(chunk);
  return out;
}

test('streaming yields chunks in order and stops at [DONE]', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => sseResponse(['Hel', 'lo', ' world', '[DONE]']);

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  const { provider, stream } = await cascade.generate({ system: 's', user: 'u', stream: true });
  assert.equal(provider, 'groq');
  assert.deepEqual(await collect(stream), ['Hel', 'lo', ' world']);
});

test('streaming falls over to the next provider if the first one fails before any chunk', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500, json: async () => ({ error: { message: 'no content' } }) };
    return sseResponse(['ok', '[DONE]']);
  };

  const cascade = new LLMCascade({ keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'] });
  const { provider, stream } = await cascade.generate({ system: 's', user: 'u', stream: true });
  assert.equal(provider, 'cerebras');
  assert.deepEqual(await collect(stream), ['ok']);
});

test('breaking out of a stream early releases the reader (no dangling read)', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let releaseLockCalls = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'b' } }] })}\n\n`));
      // deliberately never closes — simulates a stream the consumer abandons mid-way
    },
  });
  const originalGetReader = body.getReader.bind(body);
  body.getReader = (...args) => {
    const reader = originalGetReader(...args);
    const originalRelease = reader.releaseLock.bind(reader);
    reader.releaseLock = (...a) => { releaseLockCalls++; return originalRelease(...a); };
    return reader;
  };
  global.fetch = async () => ({ ok: true, status: 200, body });

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  const { stream } = await cascade.generate({ system: 's', user: 'u', stream: true });
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunks.length === 1) break; // abandon after the first chunk
  }
  assert.deepEqual(chunks, ['a']);
  assert.equal(releaseLockCalls, 1);
});

test('PROVIDER_INFO carries a signupUrl and freeTierNotes for every provider (what the keys CLI reads)', () => {
  for (const provider of ALL_PROVIDERS) {
    const info = PROVIDER_INFO[provider];
    assert.ok(info.envVar, `${provider} is missing envVar`);
    assert.ok(info.signupUrl, `${provider} is missing signupUrl`);
    assert.ok(info.freeTierNotes, `${provider} is missing freeTierNotes`);
  }
});

// ---------------------------------------------------------------------------
// Security / performance regressions (see the audit that introduced them)
// ---------------------------------------------------------------------------

const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

test('redact and parseJsonLoose stay linear on long whitespace-heavy input (no regex backtracking blow-up)', () => {
  const pad = ' '.repeat(200_000);
  let t = Date.now();
  redact(`api key${pad}`);
  const redactMs = Date.now() - t;
  t = Date.now();
  parseJsonLoose(`{"a":1}${pad}`);
  const parseMs = Date.now() - t;
  // Both took 40–150 s before the fix; anything under a second is linear.
  assert.ok(redactMs < 1000, `redact took ${redactMs}ms`);
  assert.ok(parseMs < 1000, `parseJsonLoose took ${parseMs}ms`);
  assert.deepEqual(parseJsonLoose('```JSON\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('  {"a":1}  '), { a: 1 });
});

test('redact scrubs literal secrets regardless of how the provider phrased the error', () => {
  const key = 'gsk_AbCdEfGh1234567890XyZ';
  assert.equal(redact(`Incorrect key provided: ${key}`, [key]), 'Incorrect key provided: [redacted]');
  assert.equal(redact(`token ${key} is invalid (${key})`, [key]), 'token [redacted] is invalid ([redacted])');
  assert.equal(redact('nothing here', [key]), 'nothing here');
  assert.equal(redact('x', ['']), 'x'); // empty/short secrets are ignored, never split on ''
});

test('the cascade scrubs its own configured keys from hook messages and the thrown error', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const key = 'gsk_AbCdEfGh1234567890XyZ';
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: `upstream rejected ${key}` } }) });

  const messages = [];
  const cascade = new LLMCascade({ keys: { groq: key }, order: ['groq'], onProviderFailure: (_, m) => messages.push(m) });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }), (err) => {
    assert.ok(!err.message.includes(key), 'thrown message should not contain the key');
    assert.equal(err.failures.length, 1);
    assert.equal(err.failures[0].provider, 'groq');
    assert.ok(!err.failures[0].message.includes(key));
    return true;
  });
  assert.ok(!messages[0].includes(key));
});

test('a provider that sends headers then stalls the body times out and falls over', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async (url, { signal }) => {
    calls++;
    if (calls === 1) {
      return {
        ok: true, status: 200,
        json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()))),
      };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'from cerebras' } }] }) };
  };

  const cascade = new LLMCascade({ keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], timeoutMs: 30 });
  const failures = [];
  cascade.onProviderFailure = (p, m) => failures.push(`${p}: ${m}`);
  const result = await cascade.generate({ system: 's', user: 'u' });
  assert.equal(result.provider, 'cerebras');
  assert.match(failures[0], /groq network error: timed out after 30ms/);
});

/** An SSE body that emits `chunks` with `gapMs` between each, then closes (or stalls forever if `stall`). */
function slowSseResponse(chunks, gapMs, { stall = false } = {}) {
  const encoder = new TextEncoder();
  return async (url, { signal }) => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        let i = 0;
        const push = () => {
          if (signal.aborted) return;
          if (i < chunks.length) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`));
            setTimeout(push, gapMs);
          } else if (!stall) {
            controller.close();
          }
        };
        signal.addEventListener('abort', () => { try { controller.error(abortError()); } catch { /* already closed */ } });
        push();
      },
    }),
  });
}

test('streaming: the timeout is per-chunk (idle), so a long stream that keeps producing is not cut off', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  // 6 chunks x 25 ms = 150 ms total, well past a 60 ms timeout — but never 60 ms idle.
  global.fetch = slowSseResponse(['a', 'b', 'c', 'd', 'e', 'f'], 25);

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'], timeoutMs: 60 });
  const { stream } = await cascade.generate({ system: 's', user: 'u', stream: true });
  assert.deepEqual(await collect(stream), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('streaming: a stream that goes quiet mid-way fails with a "timed out" error, not a raw AbortError', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = slowSseResponse(['a'], 10, { stall: true });

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'], timeoutMs: 40 });
  const { stream } = await cascade.generate({ system: 's', user: 'u', stream: true });
  const chunks = [];
  await assert.rejects(async () => { for await (const c of stream) chunks.push(c); }, /groq network error: timed out after 40ms/);
  assert.deepEqual(chunks, ['a']);
});

test('streaming: an empty stream counts as a failure and falls over to the next provider', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => (++calls === 1 ? sseResponse(['[DONE]']) : sseResponse(['ok', '[DONE]']));

  const cascade = new LLMCascade({ keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'] });
  const { provider, stream } = await cascade.generate({ system: 's', user: 'u', stream: true });
  assert.equal(provider, 'cerebras');
  assert.deepEqual(await collect(stream), ['ok']);
});

test('streaming: an SSE event with no boundary is capped instead of buffered without limit', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        const blob = encoder.encode('data: ' + 'x'.repeat(256 * 1024)); // no "\n\n" anywhere
        for (let i = 0; i < 6; i++) controller.enqueue(blob); // 1.5 MB total
        controller.close();
      },
    }),
  });

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u', stream: true }), /SSE event exceeded/);
});

test('deadlineMs bounds the whole call and throws DEADLINE_EXCEEDED (504) with the failures so far', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async (url, { signal }) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError())));
  };

  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2', gemini: 'k3' },
    order: ['groq', 'cerebras', 'gemini'],
    timeoutMs: 1000,
    deadlineMs: 50,
  });
  const started = Date.now();
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }), (err) => {
    assert.equal(err.code, 'DEADLINE_EXCEEDED');
    assert.equal(err.statusCode, 504);
    assert.ok(err.failures.length >= 1 && err.failures.length < 3, `expected 1-2 attempts, got ${err.failures.length}`);
    return true;
  });
  assert.ok(Date.now() - started < 500, 'should not have waited a full timeoutMs per provider');
  assert.ok(calls < 3);
});

test('cloudflareAccountId must be a 32-char hex ID (it is spliced into a URL path)', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let seen;
  global.fetch = async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; };

  const bad = new LLMCascade({ keys: { cloudflare: 'tok' }, order: ['cloudflare'], cloudflareAccountId: 'abc/../../../evil?x=' });
  await assert.rejects(() => bad.generate({ system: 's', user: 'u' }), /32-character hex account ID/);
  assert.equal(seen, undefined, 'no request should be sent with a malformed account id');

  const id = 'a'.repeat(32);
  const good = new LLMCascade({ keys: { cloudflare: 'tok' }, order: ['cloudflare'], cloudflareAccountId: id });
  await good.generate({ system: 's', user: 'u' });
  assert.equal(seen, `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1/chat/completions`);
});

test('duplicate providers in order are collapsed so a provider is only tried once per call', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; };

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq', 'groq', 'groq'] });
  assert.deepEqual(cascade.order, ['groq']);
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  assert.equal(calls, 1);
});

test('a 401 on one provider cools it down when another provider is still live', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key' } }) });

  const cooled = [];
  const cascade = new LLMCascade({ keys: { groq: 'k1', cerebras: 'k2' }, order: ['groq', 'cerebras'], onProviderCooldown: (p, ms) => cooled.push([p, ms]) });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  assert.deepEqual(cooled, [['groq', 10 * 60 * 1000]]); // cerebras is last-standing, never cooled
});

test('rateLimitCooldownMs is used for 429s, cooldownMs for structural failures', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => (++calls === 1
    ? { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit exceeded' } }) }
    : { ok: false, status: 400, json: async () => ({ error: { message: 'bad model' } }) });

  const cooled = [];
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2', gemini: 'k3' },
    order: ['groq', 'cerebras', 'gemini'],
    cooldownMs: 5000,
    rateLimitCooldownMs: 100,
    onProviderCooldown: (p, ms) => cooled.push([p, ms]),
  });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }));
  assert.deepEqual(cooled, [['groq', 100], ['cerebras', 5000]]);
});

test('maxTokensLimit clamps a caller-supplied maxTokens; nonsense values fall back to the default', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const sent = [];
  global.fetch = async (url, { body }) => { sent.push(JSON.parse(body).max_tokens); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; };

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'], maxTokensLimit: 512 });
  await cascade.generate({ system: 's', user: 'u', maxTokens: 1_000_000 });
  await cascade.generate({ system: 's', user: 'u', maxTokens: 100 });
  await cascade.generate({ system: 's', user: 'u', maxTokens: -5 });
  await cascade.generate({ system: 's', user: 'u', maxTokens: 'lots' });
  assert.deepEqual(sent, [512, 100, 512, 512]);
});

test('cooldownStore.getMany is preferred over per-provider get when present', async () => {
  const gets = [];
  let manyCalls = 0;
  const cascade = new LLMCascade({
    keys: { groq: 'k1', cerebras: 'k2' },
    order: ['groq', 'cerebras'],
    cooldownStore: {
      get: (p) => { gets.push(p); return 0; },
      set: () => {},
      getMany: (providers) => { manyCalls++; return providers.map((p) => (p === 'groq' ? Date.now() + 60_000 : 0)); },
    },
  });
  assert.deepEqual(await cascade.getLiveOrder(), ['cerebras']);
  assert.equal(manyCalls, 1);
  assert.deepEqual(gets, []);
});

test('provider error detail is capped so a huge upstream error body cannot balloon the thrown message', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'x'.repeat(1_000_000) } }) });

  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  await assert.rejects(() => cascade.generate({ system: 's', user: 'u' }), (err) => {
    assert.ok(err.message.length < 3000, `message length ${err.message.length}`);
    return true;
  });
});
