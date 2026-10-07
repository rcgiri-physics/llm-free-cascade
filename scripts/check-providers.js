#!/usr/bin/env node
'use strict';

/**
 * Checks every provider's default (and fallback) models against the
 * provider's own model-listing endpoint, so a retired model name is caught
 * here instead of by a user's failing request (the usual reason for a
 * "refresh the default models" commit).
 *
 *   npm run check:providers            # providers you have a key for + the keyless ones
 *   npm run check:providers -- --json  # machine-readable
 *
 * Keys come from the environment (GROQ_API_KEY, …) exactly like fromEnv().
 * It only issues GET requests to model-list endpoints: no tokens are
 * generated, so it costs no quota. Exit code 1 if a model is missing.
 */

const { PROVIDER_INFO } = require('../src/index.js');

// Providers whose model list is public (no key needed).
const KEYLESS = new Set(['openrouter', 'ovh', 'llm7', 'modelscope', 'pollinations']);
// Providers with no OpenAI-style GET {baseUrl}/models listing.
const NO_LISTING = new Set(['cloudflare']);

function firstKey(envVar) {
  return String(process.env[envVar] || '').split(',')[0].trim() || String(process.env[`${envVar}_2`] || '').trim();
}

async function listModels(provider, info, key) {
  const headers = {};
  let url = `${info.baseUrl}/models`;
  if (info.apiStyle === 'gemini') {
    url = `${info.baseUrl}?pageSize=1000`;
    headers['x-goog-api-key'] = key;
  } else if (info.apiStyle === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models?limit=1000';
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body) ? body : body.data || body.models || [];
  // Gemini ids look like "models/gemini-3.6-flash"; everyone else uses plain ids.
  return new Set(items.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean));
}

async function main() {
  const asJson = process.argv.includes('--json');
  const report = [];

  for (const [provider, info] of Object.entries(PROVIDER_INFO)) {
    const key = firstKey(info.envVar);
    const row = { provider, checked: false, missing: [], note: '' };
    report.push(row);

    if (NO_LISTING.has(provider) || !info.baseUrl) { row.note = 'no model-list endpoint'; continue; }
    if (!key && !KEYLESS.has(provider)) { row.note = `skipped (no ${info.envVar})`; continue; }

    try {
      const available = await listModels(provider, info, key);
      row.checked = true;
      row.available = available.size;
      row.missing = [info.defaultModel, ...(info.fallbackModels || [])].filter((m) => !available.has(m));
      row.note = row.missing.length ? 'MISSING' : 'ok';
    } catch (err) {
      row.note = `could not list models (${err.message})`;
    }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\nProvider model check\n');
    for (const r of report) {
      const mark = !r.checked ? '-' : r.missing.length ? '✗' : '✓';
      const extra = r.missing.length ? `  retired/renamed: ${r.missing.join(', ')}` : '';
      console.log(`  ${mark} ${r.provider.padEnd(13)} ${r.note}${extra}`);
    }
    console.log('\n  - = not checked (no key / no listing endpoint). Set the provider\'s env var to check it.\n');
  }
  process.exitCode = report.some((r) => r.missing.length) ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
