'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LLMCascade, parseJsonLoose } = require('../src/index.js');

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
