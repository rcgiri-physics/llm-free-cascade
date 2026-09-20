#!/usr/bin/env node
'use strict';

/**
 * llm-free-cascade CLI — a guided helper for finding and going to get more
 * free-tier API keys. It never signs up for anything on your behalf: it
 * only tells you what's missing and, if you ask, opens the signup pages or
 * writes a .env skeleton for you to fill in yourself.
 *
 * Driven entirely by PROVIDER_INFO (== providers.json) at runtime, so any
 * provider added there later shows up here automatically — no CLI changes
 * needed per CONTRIBUTING.md's "add a provider" recipe.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROVIDER_INFO } = require('../src/index.js');

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

function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('--')) || 'keys';
  const shouldOpen = args.includes('--open');
  const shouldWriteEnv = args.includes('--env');

  if (command !== 'keys') {
    console.log(`Unknown command "${command}". Usage: llm-free-cascade keys [--open] [--env]`);
    process.exitCode = 1;
    return;
  }

  const { missing } = printTable(providerStatuses());

  if (shouldOpen && missing.length) {
    console.log(`\nOpening ${missing.length} signup page(s)...`);
    missing.forEach((s, i) => setTimeout(() => openUrl(s.signupUrl), i * 400));
  }

  if (shouldWriteEnv) {
    writeEnvSkeleton(missing);
  }
}

main();
