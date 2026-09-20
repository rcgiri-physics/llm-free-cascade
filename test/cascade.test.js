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

test('order filters to only providers with a key', () => {
  const cascade = new LLMCascade({
    keys: { groq: 'k1', gemini: 'k2' },
    order: ['gemini', 'groq', 'cerebras'],
  });
  assert.deepEqual(cascade._liveOrder(), ['gemini', 'groq']);
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

test('getLiveOrder is a public wrapper around the live provider chain', () => {
  const cascade = new LLMCascade({ keys: { groq: 'k1' }, order: ['groq'] });
  assert.deepEqual(cascade.getLiveOrder(), ['groq']);
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
