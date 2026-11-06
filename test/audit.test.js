'use strict';

// Regression tests for the failover, streaming and server bugs fixed after the
// 0.10.0 audit, plus the Gemini and Anthropic stream parsers.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { LLMCascade, redact } = require('../src/index.js');
const { createServer } = require('../src/server.js');

const G = { system: 's', user: 'u' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const ok = (extra = {}) => json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], ...extra });
const sse = (...chunks) => new Response(new ReadableStream({
  start(c) {
    for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
    c.close();
  },
}), { status: 200 });
const delta = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
async function drain(result) {
  let text = '';
  for await (const chunk of result.stream) text += chunk;
  return text;
}

const originalFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ok(); });
afterEach(() => { global.fetch = originalFetch; });

// ---- provider health

test('a 400 about this request skips the provider without benching it', async () => {
  const cooled = [];
  global.fetch = async (u) => (String(u).includes('groq') ? json({ error: { message: "'messages' must contain the word 'json'" } }, 400) : ok());
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], onProviderCooldown: (p) => cooled.push(p) });
  assert.equal((await c.generate({ ...G, json: true })).provider, 'mistral');
  assert.deepEqual(cooled, []);
  assert.deepEqual(await c.getLiveOrder(), ['groq', 'mistral']);
});

test('a Gemini safety block does not bench Gemini, but MAX_TOKENS still does', async () => {
  for (const [reason, expected] of [['SAFETY', []], ['MAX_TOKENS', ['gemini']]]) {
    const cooled = [];
    global.fetch = async (u) => (String(u).includes('generativelanguage')
      ? json({ candidates: [{ finishReason: reason, content: { parts: [] } }] })
      : ok());
    const c = new LLMCascade({ keys: { gemini: 'a', mistral: 'b' }, order: ['gemini', 'mistral'], models: { gemini: 'm' }, onProviderCooldown: (p) => cooled.push(p) });
    await c.generate(G);
    assert.deepEqual(cooled, expected);
  }
});

test('a 402 moves on to the next key', async () => {
  let n = 0;
  global.fetch = async () => (++n === 1 ? json({ error: { message: 'Payment required' } }, 402) : ok());
  const c = new LLMCascade({ keys: { openrouter: ['a', 'b'] }, models: { openrouter: 'm' } });
  assert.equal((await c.generate(G)).text, 'ok');
  assert.equal(n, 2);
});

test('error bodies are read in every common shape', async () => {
  const shapes = [
    [json({ error: 'context length exceeded' }, 400), 'context length exceeded'],
    [json({ detail: 'nope' }, 400), 'nope'],
    [json({ errors: [{ message: 'cf says no' }] }, 400), 'cf says no'],
    [json([{ error: { message: 'in array' } }], 400), 'in array'],
    [new Response('plain text failure', { status: 400 }), 'plain text failure'],
  ];
  for (const [res, expected] of shapes) {
    global.fetch = async () => res;
    const c = new LLMCascade({ keys: { groq: 'a' } });
    const err = await c.generate(G).catch((e) => e);
    assert.match(err.failures[0].message, new RegExp(expected));
  }
});

test('a broken cooldownStore never breaks the cascade, and the cooldown is kept locally', async () => {
  global.fetch = async (u) => (String(u).includes('groq') ? json({ error: { message: 'x' } }, 429) : ok());
  const boom = () => { throw new Error('redis down'); };
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], cooldownStore: { get: boom, set: boom } });
  assert.equal((await c.generate(G)).provider, 'mistral');
  assert.deepEqual(await c.getLiveOrder(), ['mistral']);
  await c.stats();
  await c.clearCooldown('groq');
  assert.deepEqual(await c.getLiveOrder(), ['groq', 'mistral']);
});

test('the breaker doubles when it trips again, and resets after a success', async () => {
  const cooled = [];
  let healthy = false;
  global.fetch = async (u) => (String(u).includes('groq') && !healthy ? json({ error: { message: 'x' } }, 500) : ok());
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], models: { groq: 'm' }, onProviderCooldown: (p, ms) => cooled.push(ms) });
  const trip = async () => {
    await c.generate(G);
    await c.generate(G);
    await c.cooldownStore.set('groq', 0);
  };
  await trip();
  await trip();
  assert.deepEqual(cooled, [60000, 120000]);
  healthy = true;
  await c.generate(G);
  healthy = false;
  await trip();
  assert.deepEqual(cooled, [60000, 120000, 60000]);
});

test('deadlineMs also bounds the key and model attempts inside one provider', async () => {
  global.fetch = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return json({ error: { message: 'x' } }, 429);
  };
  const c = new LLMCascade({ keys: { groq: ['a', 'b', 'c', 'd'] }, models: { groq: ['m1', 'm2', 'm3'] }, deadlineMs: 80 });
  const started = Date.now();
  const err = await c.generate(G).catch((e) => e);
  assert.equal(err.code, 'DEADLINE_EXCEEDED');
  assert.ok(Date.now() - started < 300);
});

test('sticky tries the last provider that worked first', async () => {
  let groqDown = true;
  global.fetch = async (u) => (String(u).includes('groq') && groqDown ? json({ error: { message: 'x' } }, 400) : ok());
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], sticky: true });
  assert.equal((await c.generate(G)).provider, 'mistral');
  groqDown = false;
  assert.equal((await c.generate(G)).provider, 'mistral');
});

// ---- parameters and results

test('array content from a provider is read as text', async () => {
  global.fetch = async () => json({ choices: [{ message: { content: [{ type: 'text', text: 'hello' }] } }] });
  assert.equal((await new LLMCascade({ keys: { mistral: 'a' } }).generate(G)).text, 'hello');
});

test('results say which model answered and why it stopped', async () => {
  global.fetch = async () => json({ choices: [{ message: { content: 'half' }, finish_reason: 'length' }] });
  const r = await new LLMCascade({ keys: { groq: 'a' }, models: { groq: 'my-model' } }).generate(G);
  assert.equal(r.model, 'my-model');
  assert.equal(r.finishReason, 'length');

  global.fetch = async () => json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'x' }] } }] });
  assert.equal((await new LLMCascade({ keys: { gemini: 'a' } }).generate(G)).finishReason, 'length');

  global.fetch = async () => json({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' });
  assert.equal((await new LLMCascade({ keys: { anthropic: 'a' } }).generate(G)).finishReason, 'length');
});

test('sampling parameters reach each provider in its own format', async () => {
  const params = { ...G, temperature: 0, topP: 0.5, stop: 'END', seed: 7 };
  let body;
  const capture = (res) => async (u, o) => { body = JSON.parse(o.body); return res(); };

  global.fetch = capture(() => ok());
  await new LLMCascade({ keys: { groq: 'a' } }).generate(params);
  assert.deepEqual([body.temperature, body.top_p, body.stop, body.seed], [0, 0.5, ['END'], 7]);

  global.fetch = capture(() => json({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
  await new LLMCascade({ keys: { gemini: 'a' } }).generate(params);
  const g = body.generationConfig;
  assert.deepEqual([g.temperature, g.topP, g.stopSequences, g.seed], [0, 0.5, ['END'], 7]);

  global.fetch = capture(() => json({ content: [{ type: 'text', text: 'x' }] }));
  await new LLMCascade({ keys: { anthropic: 'a' } }).generate(params);
  assert.deepEqual([body.temperature, body.top_p, body.stop_sequences, body.seed], [0, 0.5, ['END'], undefined]);
});

test('invalid sampling parameters and system prompts are rejected before any request', async () => {
  global.fetch = async () => assert.fail('no request expected');
  const c = new LLMCascade({ keys: { groq: 'a' } });
  for (const bad of [{ temperature: 'hot' }, { stop: [] }, { stop: [1] }, { seed: 'x' }, { system: 5 }]) {
    const err = await c.generate({ ...G, ...bad }).catch((e) => e);
    assert.equal(err.code, 'INVALID_INPUT');
  }
});

test('an omitted system prompt is left out of the request', async () => {
  let body;
  global.fetch = async (u, o) => { body = JSON.parse(o.body); return ok(); };
  await new LLMCascade({ keys: { groq: 'a' } }).generate({ user: 'u' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'u' }]);

  global.fetch = async (u, o) => { body = JSON.parse(o.body); return json({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }); };
  await new LLMCascade({ keys: { gemini: 'a' } }).generate({ user: 'u' });
  assert.equal(body.system_instruction, undefined);
});

test('a keyless custom provider joins the chain', async () => {
  const c = new LLMCascade({ custom: { ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama', keyless: true } } });
  assert.equal((await c.generate(G)).provider, 'ollama');
});

test('requests refuse to follow redirects', async () => {
  let redirect;
  global.fetch = async (u, o) => { redirect = o.redirect; return ok(); };
  await new LLMCascade({ keys: { groq: 'a' } }).generate(G);
  assert.equal(redirect, 'error');
});

test('redact catches provider key shapes, and custom header secrets are scrubbed', async () => {
  assert.doesNotMatch(redact('bad sk-abcdefghijklmnopqrstuv here'), /abcdefghij/);
  assert.doesNotMatch(redact('bad gsk_abcdefghijklmnopqrstuv here'), /abcdefghij/);
  assert.doesNotMatch(redact(`bad AIza${'x'.repeat(35)} here`), /xxxx/);

  global.fetch = async () => json({ error: { message: 'echo topsecretvalue' } }, 400);
  const c = new LLMCascade({ custom: { gw: { baseUrl: 'https://gw.example/v1', model: 'm', apiKey: 'k1234', headers: { 'X-Token': 'topsecretvalue' } } } });
  const err = await c.generate(G).catch((e) => e);
  assert.doesNotMatch(err.message, /topsecretvalue/);
});

test('an aborted signal rejects with ABORTED and penalises nobody', async () => {
  const cooled = [];
  const controller = new AbortController();
  global.fetch = async (u, o) => new Promise((_, reject) => {
    o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    controller.abort();
  });
  const c = new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'], onProviderCooldown: (p) => cooled.push(p) });
  const err = await c.generate({ ...G, signal: controller.signal }).catch((e) => e);
  assert.equal(err.code, 'ABORTED');
  assert.deepEqual(cooled, []);
  assert.equal((await c.stats()).providers.groq.failures, 0);

  const again = await c.generate({ ...G, signal: controller.signal }).catch((e) => e);
  assert.equal(again.code, 'ABORTED');
});

// ---- streaming

test('SSE: CRLF, a pair split across chunks, and a final event with no blank line', async () => {
  const stream = (...chunks) => {
    global.fetch = async () => sse(...chunks);
    return new LLMCascade({ keys: { groq: 'a' } }).generate({ ...G, stream: true }).then(drain);
  };
  assert.equal(await stream(delta('hi').replace(/\n/g, '\r\n'), 'data: [DONE]\r\n\r\n'), 'hi');
  assert.equal(await stream(`${delta('a').trimEnd()}\r`, '\n\r\n', delta('b')), 'ab');
  assert.equal(await stream(delta('a'), delta('b').trimEnd()), 'ab');
});

test('SSE: a chunk holding many events is not mistaken for one oversized event', async () => {
  global.fetch = async () => sse(delta('x'.repeat(1000)).repeat(1200));
  const text = await drain(await new LLMCascade({ keys: { groq: 'a' } }).generate({ ...G, stream: true }));
  assert.equal(text.length, 1200000);
});

test('an error event before the first chunk falls over to the next provider', async () => {
  global.fetch = async (u) => (String(u).includes('groq')
    ? sse('data: {"error":{"message":"overloaded","code":503}}\n\n')
    : sse(delta('fine')));
  const r = await new LLMCascade({ keys: { groq: 'a', mistral: 'b' }, order: ['groq', 'mistral'] }).generate({ ...G, stream: true });
  assert.equal(r.provider, 'mistral');
  assert.equal(await drain(r), 'fine');
});

test('an error event after text was sent reaches the consumer', async () => {
  global.fetch = async () => sse(delta('partial'), 'data: {"error":{"message":"overloaded"}}\n\n');
  const r = await new LLMCascade({ keys: { groq: 'a' } }).generate({ ...G, stream: true });
  await assert.rejects(() => drain(r), /overloaded/);
});

test('streamed OpenAI-style finish reason and usage reach result.info and stats', async () => {
  global.fetch = async () => sse(
    delta('a'),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`
  );
  const c = new LLMCascade({ keys: { groq: 'a' }, models: { groq: 'm' } });
  const r = await c.generate({ ...G, stream: true });
  assert.equal(r.model, 'm');
  await drain(r);
  assert.equal(r.info.finishReason, 'length');
  assert.equal(r.info.usage.totalTokens, 3);
  assert.equal((await c.stats()).providers.groq.tokens.total, 3);
});

test('the Gemini stream parser reads text, finish reason, usage and errors', async () => {
  const event = (o) => `data: ${JSON.stringify(o)}\n\n`;
  global.fetch = async () => sse(
    event({ candidates: [{ content: { parts: [{ text: 'he' }] } }] }),
    event({ candidates: [{ content: { parts: [{ text: 'y' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { totalTokenCount: 9 } })
  );
  const c = new LLMCascade({ keys: { gemini: 'a' } });
  const r = await c.generate({ ...G, stream: true });
  assert.equal(await drain(r), 'hey');
  assert.equal(r.info.finishReason, 'length');
  assert.equal(r.info.usage.totalTokens, 9);

  global.fetch = async () => sse(event({ error: { message: 'busy', code: 429 } }));
  const err = await new LLMCascade({ keys: { gemini: 'a' }, models: { gemini: 'm' } }).generate({ ...G, stream: true }).catch((e) => e);
  assert.equal(err.code, 'ALL_RATE_LIMITED');
});

test('the Anthropic stream parser reads text, finish reason, usage and errors', async () => {
  const event = (o) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
  global.fetch = async () => sse(
    event({ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1 } } }),
    event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'yo' } }),
    event({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 6 } })
  );
  const r = await new LLMCascade({ keys: { anthropic: 'a' } }).generate({ ...G, stream: true });
  assert.equal(await drain(r), 'yo');
  assert.equal(r.info.finishReason, 'length');
  assert.deepEqual(r.info.usage, { promptTokens: 4, completionTokens: 6, totalTokens: 10 });

  global.fetch = async () => sse(event({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  const err = await new LLMCascade({ keys: { anthropic: 'a' } }).generate({ ...G, stream: true }).catch((e) => e);
  assert.match(err.failures[0].message, /HTTP 529: Overloaded/);
});

// ---- server

async function withServer(cascade, fn) {
  const server = createServer({ cascade });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port, server); } finally { await new Promise((r) => server.close(r)); }
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { /* a stream */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const msgs = [{ role: 'user', content: 'hi' }];

test('serve forwards sampling parameters and reports the real model and finish reason', async () => {
  let sent;
  global.fetch = async (u, o) => {
    sent = JSON.parse(o.body);
    return json({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] });
  };
  await withServer(new LLMCascade({ keys: { groq: 'a' }, models: { groq: 'm1' } }), async (port) => {
    const res = await post(port, { messages: msgs, temperature: 0, top_p: 0.2, stop: ['X'], seed: 3 });
    assert.equal(res.status, 200);
    assert.deepEqual([sent.temperature, sent.top_p, sent.stop, sent.seed], [0, 0.2, ['X'], 3]);
    assert.equal(res.json.model, 'm1');
    assert.equal(res.json.choices[0].finish_reason, 'length');
    assert.equal(res.headers['x-llm-provider'], 'groq');
  });
});

test('serve rejects parameters it cannot honour, but accepts their default values', async () => {
  await withServer(new LLMCascade({ keys: { groq: 'a' } }), async (port) => {
    for (const body of [{ presence_penalty: 1 }, { frequency_penalty: 0.5 }, { logprobs: true }, { logit_bias: { 1: 2 } }, { temperature: 'hot' }]) {
      assert.equal((await post(port, { messages: msgs, ...body })).status, 400, JSON.stringify(body));
    }
    const res = await post(port, { messages: msgs, presence_penalty: 0, frequency_penalty: 0, logprobs: false, logit_bias: {}, user: 'x', stream_options: {} });
    assert.equal(res.status, 200);
  });
});

test('serve streams the provider finish reason', async () => {
  global.fetch = async () => sse(delta('a'), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  await withServer(new LLMCascade({ keys: { groq: 'a' } }), async (port) => {
    const res = await post(port, { messages: msgs, stream: true });
    assert.match(res.text, /"finish_reason":"length"/);
    assert.match(res.text, /\[DONE\]/);
  });
});

test('serve aborts the provider call when a non-streaming client disconnects', async () => {
  let aborted;
  const gotAbort = new Promise((r) => { aborted = r; });
  let started;
  const gotRequest = new Promise((r) => { started = r; });
  global.fetch = async (u, o) => new Promise((_, reject) => {
    started();
    o.signal.addEventListener('abort', () => {
      aborted(true);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  await withServer(new LLMCascade({ keys: { groq: 'a' } }), async (port) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify({ messages: msgs }));
    await gotRequest;
    req.destroy();
    assert.equal(await gotAbort, true);
  });
});

test('serve bounds the time to receive a request, and handles bad URLs and content types', async () => {
  await withServer(new LLMCascade({ keys: { groq: 'a' } }), async (port, server) => {
    assert.ok(server.requestTimeout > 0);
    const raw = (path, type) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': type } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(await raw('//', 'application/json'), 400);
    assert.equal(await raw('/v1/chat/completions', 'application/jsonx'), 415);
    assert.equal(await raw('/v1/chat/completions', 'application/json; charset=utf-8'), 400);
  });
});
