#!/usr/bin/env node
'use strict';

/**
 * llm-free-cascade CLI
 *
 *   keys   [--open] [--env]          which providers are missing, and where to sign up
 *   status                           what is configured: order, keys, models, free-tier limits
 *   probe  [--watch N] [--json]      one tiny request per key, to catch dead keys / retired models
 *          [--provider a,b]
 *
 * It never signs up for anything on your behalf: it only tells you what's
 * missing and, if you ask, opens the signup pages or writes a .env skeleton
 * for you to fill in yourself. `probe` is the only command that sends a
 * (tiny) request, and so the only one that spends a little real quota.
 *
 * Driven entirely by PROVIDER_INFO (== providers.json) at runtime, so any
 * provider added there later shows up here automatically — no CLI changes
 * needed per CONTRIBUTING.md's "add a provider" recipe.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROVIDER_INFO, LLMCascade } = require('../src/index.js');

const USAGE = 'Usage: llm-free-cascade keys [--open] [--env] | status | probe [--watch N] [--json] [--provider a,b]';

function isConfigured(envVar) {
  if (String(process.env[envVar] || '').trim()) return true;
  for (let i = 2; i <= 9; i++) {
    if (String(process.env[`${envVar}_${i}`] || '').trim()) return true;
  }
  return false;
}

function providerStatuses() {
  return Object.entries(PROVIDER_INFO).map(([provider, info]) => ({
    provider,
    ...info,
    configured: isConfigured(info.envVar),
  }));
}

// Only plain https URLs with an unsurprising character set. The Windows
// branch below hands the URL to `cmd /c start`, and cmd re-parses its own
// command line — so `&`, `|`, `^`, `%` inside a URL would become shell
// syntax. providers.json is bundled and trusted, but a contributor adding a
// signupUrl with a query string shouldn't be one typo away from running a
// command on every user's machine.
const SAFE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\/-]*)?$/;

function openUrl(url) {
  const fallback = () => console.log(`  (couldn't auto-open — visit ${url} manually)`);
  if (!SAFE_URL_RE.test(url)) return fallback();

  const platform = process.platform;
  const [cmd, args] =
    platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] :
    platform === 'darwin' ? ['open', [url]] :
    ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // spawn() reports a missing binary (ENOENT — e.g. no xdg-open on a bare
    // server) asynchronously via 'error', not by throwing; without a
    // listener that becomes an uncaught exception and kills the CLI.
    child.on('error', fallback);
    child.unref();
  } catch {
    fallback();
  }
}

/** Short, honest labels for the things that matter before you sign up (or rely on) a provider. */
function flagList(info) {
  const flags = [`tier ${info.tier ?? '?'}`];
  if (info.trial) flags.push('trial/credit, not a standing free tier');
  if (info.requiresPhone) flags.push('needs phone');
  if (info.requiresCard) flags.push('needs card');
  if (info.commercialOk === false) flags.push('NON-COMMERCIAL only');
  if (info.trainsOnData) flags.push('may train on your prompts');
  if (info.region === 'cn') flags.push('China-hosted');
  if (info.limitsSource === 'unverified' || info.limitsSource === 'tracker') flags.push(`limits: ${info.limitsSource}`);
  return flags;
}

function fmtLimits(l = {}) {
  const parts = [
    l.rpm && `${l.rpm} RPM`, l.rps && `${l.rps} RPS`, l.rpd && `${l.rpd} RPD`,
    l.tpm && `${l.tpm} TPM`, l.tpd && `${l.tpd} TPD`,
    l.perModel && 'per model', l.scope && `per ${l.scope}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'see the provider\'s own console';
}

function printTable(statuses) {
  const configured = statuses.filter((s) => s.configured);
  const missing = statuses.filter((s) => !s.configured);

  console.log(`\nllm-free-cascade — ${configured.length}/${statuses.length} providers configured\n`);
  for (const s of statuses) {
    console.log(`  ${s.configured ? '✓' : '✗'} ${s.provider.padEnd(12)} ${s.envVar}`);
  }

  if (missing.length) {
    console.log(`\nGet more free keys (${missing.length} missing):\n`);
    for (const s of missing) {
      console.log(`  ${s.provider.padEnd(12)} ${s.signupUrl}`);
      console.log(`  ${''.padEnd(12)} ${s.freeTierNotes}`);
      console.log(`  ${''.padEnd(12)} [${flagList(s).join(', ')}]`);
    }
  } else {
    console.log('\nAll known providers are configured.');
  }
  return { configured, missing };
}

function writeEnvSkeleton(missing) {
  const envPath = path.join(process.cwd(), '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const existingVars = new Set(
    existing.split('\n').map((l) => l.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean)
  );

  const linesToAdd = missing.filter((s) => !existingVars.has(s.envVar)).map((s) => `# ${s.envVar}=`);
  if (!linesToAdd.length) {
    console.log('\n.env already has a line for every missing provider — nothing to add.');
    return;
  }

  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const addition = `${separator}${existing ? '\n' : ''}# Added by \`npx llm-free-cascade keys --env\` — fill in the ones you sign up for\n${linesToAdd.join('\n')}\n`;
  fs.writeFileSync(envPath, existing + addition);
  console.log(`\nAppended ${linesToAdd.length} commented-out var(s) to ${envPath}`);
}

function printStatus() {
  const cascade = LLMCascade.fromEnv();
  const providers = cascade.order;
  console.log(`\nllm-free-cascade — ${providers.length} provider(s) configured, in this order:\n`);
  if (!providers.length) {
    console.log('  none. Run `npx llm-free-cascade keys` to see where to get free keys.\n');
    return;
  }
  providers.forEach((p, i) => {
    const info = cascade._meta[p];
    console.log(`  ${String(i + 1).padStart(2)}. ${p.padEnd(12)} ${cascade.keys[p].length} key(s)  [${flagList(info).join(', ')}]`);
    console.log(`      models: ${cascade._modelsFor(p).join(' -> ')}`);
    console.log(`      limits: ${fmtLimits(info.limits)}`);
    if (info.commercialOk === false) console.log('      WARNING: non-commercial terms. Do not use this key in a product.');
  });
  const total = providers.reduce((n, p) => n + cascade.keys[p].length, 0);
  console.log(`\n  ${total} key(s) in total. Live check (spends a little quota): npx llm-free-cascade probe\n`);
}

async function runProbe(args) {
  const asJson = args.includes('--json');
  const watchAt = args.indexOf('--watch');
  const watchSec = watchAt >= 0 ? Number(args[watchAt + 1]) : 0;
  const providerAt = args.indexOf('--provider');
  const only = providerAt >= 0
    ? String(args[providerAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  if (watchAt >= 0 && !(watchSec >= 10)) {
    console.log('--watch needs a number of seconds, at least 10 (every round spends a little quota on every key).');
    process.exitCode = 1;
    return;
  }

  const once = async () => {
    const cascade = LLMCascade.fromEnv();
    if (!cascade.order.length) {
      console.log('No provider keys found in the environment. Run `npx llm-free-cascade keys`.');
      process.exitCode = 1;
      return;
    }
    const results = await cascade.probe({ providers: only });
    if (asJson) {
      console.log(JSON.stringify({ at: new Date().toISOString(), results }));
    } else {
      console.log(`\nprobe @ ${new Date().toLocaleTimeString()}`);
      for (const r of results) {
        const detail = r.ok ? `${r.ms} ms` : `${r.status ?? 'error'}  ${(r.message || '').slice(0, 110)}`;
        console.log(`  ${r.ok ? '✓' : '✗'} ${r.provider.padEnd(12)} key #${r.keyIndex + 1}  ${r.model.padEnd(36)} ${detail}`);
      }
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  };

  await once();
  if (watchSec >= 10) {
    process.exitCode = 0;
    setInterval(() => { once().catch((e) => console.error(e.message)); }, watchSec * 1000);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'keys';

  if (command === 'status') return printStatus();
  if (command === 'probe') return runProbe(args.slice(1));

  if (command !== 'keys') {
    console.log(`Unknown command "${command}". ${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const { missing } = printTable(providerStatuses());

  if (args.includes('--open') && missing.length) {
    console.log(`\nOpening ${missing.length} signup page(s)...`);
    missing.forEach((s, i) => setTimeout(() => openUrl(s.signupUrl), i * 400));
  }

  if (args.includes('--env')) {
    writeEnvSkeleton(missing);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
