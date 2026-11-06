'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LLMCascade, fileCooldownStore, discoverFreeModels } = require('../src/index.js');

const G = { system: 's', user: 'u' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
const ok = () => json({ choices: [{ message: { content: 'ok' } }] });
const delta = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const sse = (...chunks) => new Response(new ReadableStream({
  start(c) {
    for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
    c.close();
  },
}), { status: 200 });
const failing = (text) => sse(delta(text), 'data: {"error":{"message":"died"}}\n\n');
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-')), 'sub', 'cooldowns.json');

const originalFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ok(); });
afterEach(() => { global.fetch = originalFetch; });

// ---- persisted cooldowns

test('fileCooldownStore keeps a cooldown across instances', async () => {
  const file = tempFile();
  global.fetch = async (u) => (String(u).includes('groq') ? json({ error: { message: 'x' } }, 429) : ok());
  const make = () => new LLMCascade({ keys: { groq: 'secret-key', mistral: 'b' }, order: ['groq', 'mistral'], models: { groq: 'm' }, cooldownStore: fileCooldownStore(file) });
  await make().generate(G);
  assert.deepEqual(await make().getLiveOrder(), ['mistral']);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret-key/);
  await make().clearCooldown('groq');
  assert.deepEqual(await make().getLiveOrder(), ['groq', 'mistral']);
});

test('fileCooldownStore treats a corrupt file as empty, and drops expired entries', () => {
  const file = tempFile();
  const store = fileCooldownStore(file);
  assert.equal(store.get('groq'), 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.equal(store.get('groq'), 0);
  assert.equal(store.get('constructor'), 0);
  fs.writeFileSync(file, JSON.stringify({ old: 1 }));
  store.set('groq', Date.now() + 60000);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['groq']);
  assert.deepEqual(store.getMany(['groq', 'old']).map((t) => t > Date.now()), [true, false]);
});

test('fromEnv uses LLM_CASCADE_COOLDOWN_FILE', async () => {
  const file = tempFile();
  process.env.LLM_CASCADE_COOLDOWN_FILE = file;
  try {
    const c = LLMCascade.fromEnv({ keys: { groq: 'a', mistral: 'b' } });
    await c.cooldownStore.set('groq', Date.now() + 60000);
    assert.ok(fs.existsSync(file));
  } finally {
    delete process.env.LLM_CASCADE_COOLDOWN_FILE;
  }
});

// ---- discovery

test('discoverFreeModels returns only free models, largest context first', async () => {
  global.fetch = async () => json({ data: [
    { id: 'a/paid', context_length: 999999 },
    { id: 'b/small:free', context_length: 10 },
    { id: 'c/big:free', name: 'Big', context_length: 100 },
    { id: 'd/unknown:free' },
  ] });
  const models = await discoverFreeModels();
  assert.deepEqual(models.map((m) => m.id), ['c/big:free', 'b/small:free', 'd/unknown:free']);
  assert.equal(models[0].name, 'Big');
  assert.equal(models[2].contextLength, null);

  global.fetch = async () => json({}, 503);
  await assert.rejects(() => discoverFreeModels(), /HTTP 503/);
});

// ---- stream restart

test('onRestart: a stream that dies moves to the next provider and says so', async () => {
  global.fetch = async (u) => (String(u).includes('groq') ? failing('stale ') : sse(delta('fresh')));
  const restarts = [];
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], models: { mistral: 'mm' } });
  const r = await c.generate({ ...G, stream: true, onRestart: (e) => restarts.push(e) });
  const pieces = [];
  for await (const piece of r.stream) {
    if (restarts.length && pieces[0] === 'stale ') pieces.length = 0;
    pieces.push(piece);
  }
  assert.deepEqual(pieces, ['fresh']);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].from, 'groq');
  assert.equal(restarts[0].to, 'mistral');
  assert.match(restarts[0].error, /died/);
  assert.equal(r.provider, 'mistral');
  assert.equal(r.model, 'mm');
  assert.equal(r.attempts[0].provider, 'groq');
});

test('onRestart: with nothing left to try, the original error reaches the consumer', async () => {
  global.fetch = async () => failing('partial');
  const restarts = [];
  const r = await new LLMCascade({ keys: { groq: 'a' } }).generate({ ...G, stream: true, onRestart: (e) => restarts.push(e) });
  await assert.rejects(async () => { for await (const piece of r.stream) assert.ok(piece); }, /died/);
  assert.deepEqual(restarts, []);
});

test('without onRestart a dying stream still rejects', async () => {
  global.fetch = async () => failing('partial');
  const r = await new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'] }).generate({ ...G, stream: true });
  await assert.rejects(async () => { for await (const piece of r.stream) assert.ok(piece); }, /died/);
});

test('onRestart must be a function', async () => {
  const err = await new LLMCascade({ keys: { groq: 'a' } }).generate({ ...G, onRestart: 'yes' }).catch((e) => e);
  assert.equal(err.code, 'INVALID_INPUT');
});

// ---- context-window routing

test('contextTokens skips a provider the prompt cannot fit, without a request', async () => {
  const hits = [];
  global.fetch = async (u) => { hits.push(String(u)); return ok(); };
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], contextTokens: { groq: 1000 } });
  const small = await c.generate({ system: 's', user: 'hi', maxTokens: 10 });
  assert.equal(small.provider, 'groq');
  hits.length = 0;
  const big = await c.generate({ system: 's', user: 'x'.repeat(8000), maxTokens: 10 });
  assert.equal(big.provider, 'mistral');
  assert.equal(hits.some((u) => u.includes('groq')), false);
});

test('a custom provider can declare contextTokens', async () => {
  const c = new LLMCascade({
    keys: { mistral: 'b' },
    order: ['tiny', 'mistral'],
    custom: { tiny: { baseUrl: 'https://tiny.example/v1', model: 'm', apiKey: 'k1234', contextTokens: 100 } },
  });
  assert.equal((await c.generate({ ...G, user: 'x'.repeat(4000), maxTokens: 10 })).provider, 'mistral');
});

test('if nothing fits, every provider is still tried', async () => {
  const c = new LLMCascade({ keys: { groq: 'a' }, contextTokens: { groq: 10 } });
  assert.equal((await c.generate({ ...G, user: 'x'.repeat(4000) })).provider, 'groq');
});

test('a context-length error is remembered for prompts of that size or larger', async () => {
  const hits = [];
  global.fetch = async (u) => {
    const url = String(u);
    hits.push(url);
    return url.includes('groq') ? json({ error: { message: 'maximum context length exceeded' } }, 400) : ok();
  };
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], models: { groq: 'm' } });
  const big = 'x'.repeat(8000);
  await c.generate({ ...G, user: big });
  hits.length = 0;
  await c.generate({ ...G, user: big });
  assert.equal(hits.some((u) => u.includes('groq')), false, 'same size skips it');
  hits.length = 0;
  await c.generate({ ...G, user: 'short' });
  assert.equal(hits.some((u) => u.includes('groq')), true, 'a smaller prompt still tries it');
});

test('probe allows room for reasoning models, and empty responses give the finish reason', async () => {
  let sent;
  global.fetch = async (u, o) => { sent = JSON.parse(o.body).max_tokens; return json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }); };
  const [result] = await new LLMCascade({ keys: { groq: 'a' } }).probe();
  assert.equal(sent, 256);
  assert.ok(result.message.includes("empty response (finish_reason: length)"), result.message);
});
