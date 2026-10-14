'use strict';

/**
 * A small OpenAI-compatible HTTP front end for an LLMCascade, so any tool that
 * accepts a custom OpenAI base URL can use the cascade without code changes.
 *
 *   POST /v1/chat/completions   (plain and `stream: true`)
 *   GET  /v1/models
 *   GET  /health
 *
 * Safe by default, because the keys behind it are yours:
 *  - binds to 127.0.0.1. Any other host is refused unless an API key is set.
 *  - Host header must be a loopback name unless an API key is set, which stops
 *    DNS-rebinding pages in your browser from reaching it.
 *  - no CORS headers, and only `application/json` bodies, so a web page can't
 *    send it a request the browser would allow without a preflight.
 *  - request bodies capped (1 MB), `max_tokens` capped, total deadline per call.
 *  - unsupported features (tools, images, n > 1) are rejected with a 400
 *    instead of being silently dropped.
 *  - error responses carry the error code only; provider error text (already
 *    redacted) is not forwarded to the client.
 */

const http = require('http');
const crypto = require('crypto');
const { LLMCascade, LLMCascadeError } = require('./index.js');

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_SYSTEM = 'You are a helpful assistant.';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MODEL_ID = 'cascade';

class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', code = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

const bad = (message, code = null) => new HttpError(400, message, 'invalid_request_error', code);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

/** `Host: localhost:8787` -> `localhost`, `Host: [::1]:8787` -> `[::1]`. */
function hostName(header = '') {
  const h = String(header).trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large (max 1 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** OpenAI content may be a string or an array of parts; only text parts are supported. */
function textContent(content, where) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part, j) => {
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
      throw bad(`${where}.content[${j}]: only text parts are supported (no images, audio or files).`);
    }).join('');
  }
  throw bad(`${where}.content must be a string or an array of text parts.`);
}

/**
 * Turns an OpenAI chat-completions body into generate() params. System and
 * developer turns become the system prompt; the cascade validates the rest.
 */
function toGenerateParams(body, providers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object.');
  if (!Array.isArray(body.messages) || !body.messages.length) throw bad('"messages" must be a non-empty array.');
  if (body.tools?.length || body.functions?.length || body.tool_choice) {
    throw bad('Tool and function calling are not supported by this server yet.', 'unsupported_parameter');
  }
  if (body.n != null && body.n !== 1) throw bad('Only n = 1 is supported.', 'unsupported_parameter');

  const system = [];
  const messages = [];
  body.messages.forEach((m, i) => {
    if (!m || typeof m !== 'object') throw bad(`messages[${i}] must be an object.`);
    const text = textContent(m.content, `messages[${i}]`);
    if (m.role === 'system' || m.role === 'developer') system.push(text);
    else if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: text });
    else throw bad(`messages[${i}].role "${m.role}" is not supported (use system, user or assistant).`);
  });
  if (!messages.length) throw bad('At least one user message is required.');

  const fmt = body.response_format?.type;
  if (fmt && fmt !== 'text' && fmt !== 'json_object') {
    throw bad(`response_format "${fmt}" is not supported (use "text" or "json_object").`, 'unsupported_parameter');
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null && !(Number.isInteger(maxTokens) && maxTokens > 0)) throw bad('max_tokens must be a positive integer.');

  // "cascade" (or no model) = the whole chain; a configured provider name pins that provider.
  let order;
  if (body.model != null && body.model !== MODEL_ID) {
    if (typeof body.model !== 'string' || !providers.includes(body.model)) {
      throw new HttpError(404, `Model "${body.model}" not found. Use "${MODEL_ID}" or one of: ${providers.join(', ')}.`, 'invalid_request_error', 'model_not_found');
    }
    order = [body.model];
  }

  return {
    system: system.join('\n\n') || DEFAULT_SYSTEM,
    messages,
    json: fmt === 'json_object',
    maxTokens: maxTokens ?? undefined,
    order,
    stream: body.stream === true,
  };
}

function usageOut(u) {
  if (!u) return undefined;
  return { prompt_tokens: u.promptTokens ?? 0, completion_tokens: u.completionTokens ?? 0, total_tokens: u.totalTokens ?? 0 };
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function errorBody(err) {
  return { error: { message: err.message, type: err.type, code: err.code, param: null } };
}

/** Maps a cascade failure to an OpenAI-style error without leaking provider error text. */
function fromCascadeError(err) {
  if (err instanceof LLMCascadeError) {
    if (err.code === 'INVALID_INPUT') return bad(err.message);
    if (err.code === 'ALL_RATE_LIMITED') return new HttpError(429, 'Every provider is rate-limited right now. Retry later.', 'rate_limit_error', err.code);
    if (err.code === 'DEADLINE_EXCEEDED') return new HttpError(504, 'The cascade ran out of time.', 'timeout_error', err.code);
    return new HttpError(err.statusCode >= 500 ? err.statusCode : 502, 'Every provider failed. Check `npx llm-free-cascade probe`.', 'api_error', err.code);
  }
  return new HttpError(500, 'Internal server error.', 'api_error');
}

/**
 * @param {object} [options]
 * @param {import('./index').LLMCascade} [options.cascade] - default: LLMCascade.fromEnv() with safe limits
 * @param {string} [options.apiKey] - clients must send `Authorization: Bearer <apiKey>`. Required to bind beyond loopback.
 * @param {string} [options.host] - bind address, default 127.0.0.1 (used only to enforce the rule above)
 * @param {(line: string) => void} [options.log]
 * @returns {http.Server}
 */
function createServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const apiKey = options.apiKey || null;
  if (!apiKey && !isLoopbackHost(host)) {
    throw new Error(`Refusing to listen on ${host} without an API key. Set one, or use 127.0.0.1.`);
  }
  const cascade = options.cascade ?? LLMCascade.fromEnv({ maxTokensLimit: 8192, deadlineMs: 120000 });
  const log = options.log ?? (() => {});

  async function handle(req, res) {
    if (!apiKey && !isLoopbackHost(hostName(req.headers.host))) {
      throw new HttpError(403, 'Forbidden host.', 'permission_error');
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });

    if (apiKey) {
      const auth = String(req.headers.authorization || '');
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      if (!token || !safeEqual(token, apiKey)) throw new HttpError(401, 'Invalid or missing API key.', 'authentication_error', 'invalid_api_key');
    }

    if (path === '/v1/models' && req.method === 'GET') {
      const created = Math.floor(Date.now() / 1000);
      const ids = [MODEL_ID, ...cascade.order];
      return sendJson(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'llm-free-cascade' })) });
    }

    if (path !== '/v1/chat/completions') throw new HttpError(404, 'Not found.', 'invalid_request_error');
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'invalid_request_error');
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json.', 'invalid_request_error');
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw bad('Body is not valid JSON.');
    }
    const params = toGenerateParams(body, cascade.order);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const started = Date.now();

    let result;
    try { result = await cascade.generate(params); } catch (e) { throw fromCascadeError(e); }
    const model = result.provider;

    if (!params.stream) {
      log(`200 ${model} ${Date.now() - started}ms`);
      return sendJson(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: usageOut(result.usage),
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    // Stop pulling from the provider if the client goes away.
    let closed = false;
    res.on('close', () => { closed = true; });
    res.write(chunk({ role: 'assistant', content: '' }));
    try {
      for await (const text of result.stream) {
        if (closed) break;
        res.write(chunk({ content: text }));
      }
      if (!closed) res.write(chunk({}, 'stop'));
    } catch {
      // Headers are already sent: report in-band, the way OpenAI does.
      if (!closed) res.write(`data: ${JSON.stringify({ error: { message: 'The provider stream failed.', type: 'api_error', code: null } })}\n\n`);
    }
    if (!closed) res.end('data: [DONE]\n\n');
    log(`200 ${model} stream ${Date.now() - started}ms`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const e = err instanceof HttpError ? err : new HttpError(500, 'Internal server error.', 'api_error');
      log(`${e.status} ${req.method} ${req.url} ${e.code ?? e.type}`);
      if (res.headersSent) return res.end();
      sendJson(res, e.status, errorBody(e), e.status === 429 ? { 'retry-after': '30' } : {});
    });
  });
  server.requestTimeout = 0; // long generations and streams; the cascade has its own deadline
  server.headersTimeout = 30000;
  return server;
}

module.exports = { createServer, _internals: { toGenerateParams, hostName, isLoopbackHost } };
