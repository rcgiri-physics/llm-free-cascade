'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../src/server.js');
const { LLMCascadeError } = require('../src/index.js');

/** A stand-in cascade that records what it was asked and answers from `impl`. */
function fakeCascade(impl) {
  const calls = [];
  return {
    calls,
    order: ['groq', 'gemini'],
    async generate(params) { calls.push(params); return impl(params); },
  };
}

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { return await fn(port); } finally { await new Promise((r) => server.close(r)); }
}

/** Raw request, so tests control the Host header (fetch won't let them). */
function request(port, { method = 'POST', path = '/v1/chat/completions', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const ok = () => ({ text: 'hi there', provider: 'groq', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });

test('chat completion maps request and response to the OpenAI shape', async () => {
  const cascade = fakeCascade(ok);
  await withServer({ cascade }, async (port) => {
    const res = await request(port, { body: {
      model: 'cascade',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
      ],
      max_tokens: 50,
      response_format: { type: 'json_object' },
    } });
    assert.equal(res.status, 200);
    assert.equal(res.json.object, 'chat.completion');
    assert.equal(res.json.model, 'groq');
    assert.equal(res.json.choices[0].message.content, 'hi there');
    assert.deepEqual(res.json.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const p = cascade.calls[0];
    assert.equal(p.system, 'be brief');
    assert.deepEqual(p.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(p.json, true);
    assert.equal(p.maxTokens, 50);
    assert.equal(p.order, undefined);
  });
});

test('a provider name as model pins that provider; unknown models are 404', async () => {
  const cascade = fakeCascade(ok);
  await withServer({ cascade }, async (port) => {
    const msgs = [{ role: 'user', content: 'x' }];
    assert.equal((await request(port, { body: { model: 'gemini', messages: msgs } })).status, 200);
    assert.deepEqual(cascade.calls[0].order, ['gemini']);
    const res = await request(port, { body: { model: 'gpt-4o', messages: msgs } });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'model_not_found');
  });
});

test('streaming sends role chunk, content chunks, stop and [DONE]', async () => {
  const cascade = fakeCascade(() => ({
    provider: 'groq',
    stream: (async function* () { yield 'a'; yield 'b'; })(),
  }));
  await withServer({ cascade }, async (port) => {
    const res = await request(port, { body: { messages: [{ role: 'user', content: 'x' }], stream: true } });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const events = res.text.trim().split('\n\n').map((e) => e.replace(/^data: /, ''));
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), 'ab');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  });
});

test('unsupported features are rejected, not silently dropped', async () => {
  const cascade = fakeCascade(ok);
  await withServer({ cascade }, async (port) => {
    const msgs = [{ role: 'user', content: 'x' }];
    for (const body of [
      { messages: msgs, tools: [{ type: 'function', function: { name: 'f' } }] },
      { messages: msgs, n: 2 },
      { messages: msgs, response_format: { type: 'json_schema' } },
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x' } }] }] },
      { messages: [{ role: 'tool', content: 'r' }] },
      { messages: [] },
    ]) {
      const res = await request(port, { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error.type, 'invalid_request_error');
    }
    assert.equal(cascade.calls.length, 0);
  });
});

test('refuses non-JSON bodies, oversized bodies and bad JSON', async () => {
  await withServer({ cascade: fakeCascade(ok) }, async (port) => {
    assert.equal((await request(port, { headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await request(port, { body: '{nope' })).status, 400);
    const huge = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(1100 * 1024) }] });
    const res = await request(port, { body: huge }).catch(() => ({ status: 413 }));
    assert.equal(res.status, 413);
  });
});

test('rejects a non-loopback Host header when no API key is set (DNS rebinding)', async () => {
  await withServer({ cascade: fakeCascade(ok) }, async (port) => {
    const res = await request(port, { headers: { host: 'evil.example:80' }, body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(res.status, 403);
    assert.equal((await request(port, { method: 'GET', path: '/v1/models', headers: { host: `localhost:${port}` } })).status, 200);
  });
});

test('API key is enforced when set, and required to bind beyond loopback', async () => {
  assert.throws(() => createServer({ cascade: fakeCascade(ok), host: '0.0.0.0' }), /without an API key/);
  await withServer({ cascade: fakeCascade(ok), apiKey: 'secret' }, async (port) => {
    const body = { messages: [{ role: 'user', content: 'x' }] };
    assert.equal((await request(port, { body })).status, 401);
    assert.equal((await request(port, { body, headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request(port, { body, headers: { authorization: 'Bearer secret' } })).status, 200);
    assert.equal((await request(port, { method: 'GET', path: '/health' })).status, 200);
  });
});

test('cascade failures map to OpenAI errors without leaking provider text', async () => {
  const fail = (code, status) => () => { throw Object.assign(new LLMCascadeError('groq: key sk-leak rejected', status, code), { failures: [] }); };
  const cases = [['ALL_RATE_LIMITED', 429, 429], ['ALL_PROVIDERS_FAILED', 502, 502], ['DEADLINE_EXCEEDED', 504, 504]];
  for (const [code, status, expected] of cases) {
    await withServer({ cascade: fakeCascade(fail(code, status)) }, async (port) => {
      const res = await request(port, { body: { messages: [{ role: 'user', content: 'x' }] } });
      assert.equal(res.status, expected);
      assert.equal(res.json.error.code, code);
      assert.doesNotMatch(res.text, /sk-leak/);
    });
  }
});

test('/v1/models lists "cascade" and every configured provider', async () => {
  await withServer({ cascade: fakeCascade(ok) }, async (port) => {
    const res = await request(port, { method: 'GET', path: '/v1/models' });
    assert.deepEqual(res.json.data.map((m) => m.id), ['cascade', 'groq', 'gemini']);
  });
});
