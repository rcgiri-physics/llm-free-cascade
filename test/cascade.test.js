'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LLMCascade, parseJsonLoose, redact } = require('../src/index.js');

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
  assert.equal(cooldowns.length, 0); // HTTP 401 is key-exhausted, not a structural/provider-level failure
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
