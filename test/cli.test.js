'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROVIDER_INFO } = require('../src/index.js');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

/** Runs the CLI with no provider keys in its environment. Nothing here sends a request. */
function cli(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY|_BASE_URL|^LLM_/.test(k)));
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 20000 });
}

test('an unknown command prints usage and fails', () => {
  const r = cli(['nonsense']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /Usage: llm-free-cascade/);
});

test('keys lists every known provider when none is configured', () => {
  const r = cli(['keys']);
  assert.equal(r.status, 0);
  for (const provider of Object.keys(PROVIDER_INFO)) assert.match(r.stdout, new RegExp(provider));
});

test('status shows a configured provider and never prints its key', () => {
  const r = cli(['status'], { GROQ_API_KEY: 'super-secret-key-value' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /groq/);
  assert.doesNotMatch(r.stdout + r.stderr, /super-secret-key-value/);
});

test('serve refuses a public host without a server key', () => {
  const r = cli(['serve', '--host', '0.0.0.0', '--port', '18787'], { GROQ_API_KEY: 'k' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /API key|LLM_CASCADE_SERVER_KEY/);
});
