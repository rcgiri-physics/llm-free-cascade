#!/usr/bin/env node
'use strict';

// Generates docs/index.html (the GitHub Pages project page) from
// src/providers.json, so the provider table can't drift from the package.
//   npm run build:site

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const providers = require(path.join(root, 'src', 'providers.json'));
const pkg = require(path.join(root, 'package.json'));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIER_LABEL = { 1: 'Fast, roomy', 2: 'Solid', 3: 'Tight or niche', 4: 'Trial / unverified', 5: 'Paid last resort' };

function limitsText(l) {
  if (!l) return '';
  const parts = [];
  if (l.rpm) parts.push(`${l.rpm} RPM`);
  if (l.rps) parts.push(`${l.rps} req/s`);
  if (l.rpd) parts.push(`${Number(l.rpd).toLocaleString('en-US')} req/day`);
  if (l.tpd) parts.push(`${Number(l.tpd).toLocaleString('en-US')} tokens/day`);
  const scope = [l.perModel ? 'per model' : null, l.scope ? `per ${l.scope}` : null].filter(Boolean).join(', ');
  return [parts.join(', '), scope].filter(Boolean).join(' · ');
}

function flags(info) {
  const f = [];
  if (info.trial) f.push(['warn', 'trial']);
  if (info.requiresPhone) f.push(['warn', 'phone']);
  if (info.requiresCard) f.push(['warn', 'card']);
  if (info.commercialOk === false) f.push(['bad', 'non-commercial']);
  if (info.trainsOnData) f.push(['warn', 'trains on prompts']);
  if (info.region === 'cn') f.push(['note', 'China-hosted']);
  if (info.limitsSource === 'unverified' || info.limitsSource === 'tracker') f.push(['note', `limits: ${info.limitsSource}`]);
  return f.map(([k, t]) => `<span class="tag ${k}">${esc(t)}</span>`).join('');
}

const rows = Object.entries(providers)
  .map(([name, info]) => {
    const models = [info.defaultModel, ...(info.fallbackModels || [])];
    const host = info.signupUrl ? new URL(info.signupUrl).host : '';
    return `<tr data-tier="${esc(info.tier)}">
  <td data-label="Tier"><span class="tier t${esc(info.tier)}">${esc(info.tier)}</span></td>
  <td data-label="Provider"><strong>${esc(name)}</strong><br><code>${esc(info.envVar)}</code></td>
  <td data-label="Models">${models.map((m) => `<code>${esc(m)}</code>`).join('<br>')}</td>
  <td data-label="Free tier">${esc(limitsText(info.limits) || '—')}<div class="notes">${esc(info.freeTierNotes || '')}</div><div class="flags">${flags(info)}</div></td>
  <td data-label="Sign up">${info.signupUrl ? `<a href="${esc(info.signupUrl)}" rel="noopener">${esc(host)}</a>` : ''}<div class="notes">checked ${esc(info.verifiedAt || '?')}</div></td>
</tr>`;
  })
  .join('\n');

const tierLegend = Object.entries(TIER_LABEL)
  .map(([n, l]) => `<span class="legend"><span class="tier t${n}">${n}</span> ${esc(l)}</span>`)
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-free-cascade</title>
<meta name="description" content="Cascade one chat completion across every free-tier LLM API you have a key for, with reset-aware cooldowns and per-key, per-model rotation.">
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#63635d;--line:#e2e1da;--card:#fff;--code:#f0efe8;--accent:#0b6b4f;--warn:#8a5a00;--warnbg:#fdf0d5;--bad:#9b1c1c;--badbg:#fbe0e0;--notebg:#e9eef5;--note:#2f4a6b}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--fg:#ecebe4;--muted:#a3a29a;--line:#2c2c29;--card:#1b1b19;--code:#242421;--accent:#58c9a0;--warn:#f0c36b;--warnbg:#3a2f14;--bad:#f09a9a;--badbg:#3d1c1c;--notebg:#1f2a38;--note:#9bbbe0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header.hero{padding:56px 0 32px}
h1{font-size:2.2rem;line-height:1.2;margin:0 0 12px}
h2{font-size:1.4rem;margin:48px 0 12px}
.lead{font-size:1.15rem;color:var(--muted);max-width:42rem;margin:0 0 20px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;margin:12px 0;line-height:1.5}
pre code{background:none;padding:0}
a{color:var(--accent)}
.links a{margin-right:18px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.card h3{margin:0 0 6px;font-size:1rem}
.card p{margin:0;color:var(--muted);font-size:.95rem}
.chain{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0}
.chain span.node{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px;font-weight:600}
.chain span.node.fail{color:var(--bad);text-decoration:line-through;font-weight:500}
.chain span.node.ok{border-color:var(--accent);color:var(--accent)}
.chain i{color:var(--muted);font-style:normal}
.tools{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0 14px}
input[type=search]{padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;min-width:220px}
.legend{margin-right:12px;font-size:.88rem;color:var(--muted);white-space:nowrap}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--code)}
tr:last-child td{border-bottom:0}
.notes{color:var(--muted);font-size:.85rem;margin-top:3px}
.tier{display:inline-block;min-width:1.7em;text-align:center;border-radius:6px;padding:0 6px;font-weight:700;background:var(--code)}
.tier.t1{background:var(--accent);color:var(--bg)}
.tag{display:inline-block;font-size:.75rem;border-radius:999px;padding:1px 8px;margin:4px 4px 0 0}
.tag.warn{background:var(--warnbg);color:var(--warn)}.tag.bad{background:var(--badbg);color:var(--bad)}.tag.note{background:var(--notebg);color:var(--note)}
footer{margin:56px 0 40px;color:var(--muted);font-size:.9rem}
@media (max-width:640px){h1{font-size:1.7rem}}
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <h1>Your app shouldn't die because Groq returned a 429.</h1>
  <p class="lead"><code>llm-free-cascade</code> sends one chat completion through every free-tier LLM provider you have a key for, and moves on when one is rate-limited, out of quota, slow or down. Zero dependencies, Node 18+.</p>
  <pre><code>npm install llm-free-cascade</code></pre>
  <p class="links"><a href="https://github.com/rcgiri-physics/llm-free-cascade">GitHub</a><a href="https://www.npmjs.com/package/llm-free-cascade">npm</a><a href="https://github.com/rcgiri-physics/llm-free-cascade/blob/master/docs/GUIDE.md">Guide</a><a href="https://github.com/rcgiri-physics/llm-free-cascade/blob/master/CHANGELOG.md">Changelog</a></p>
</header>

<section>
<pre><code>const { LLMCascade } = require('llm-free-cascade');

const cascade = LLMCascade.fromEnv();   // GROQ_API_KEY, GEMINI_API_KEY, ...

const { text, provider, attempts } = await cascade.generate({
  system: 'You are a helpful assistant.',
  user: 'Explain photosynthesis in one sentence.',
});
// provider: who answered. attempts: who it skipped, and why.</code></pre>
<div class="chain" aria-label="Example chain">
  <span class="node fail">groq (429, rests 58s)</span><i>→</i>
  <span class="node fail">gemini (daily quota, rests until reset)</span><i>→</i>
  <span class="node ok">cerebras answers</span>
</div>
</section>

<h2>What a plain retry loop doesn't do</h2>
<div class="grid">
  <div class="card"><h3>Reset-aware cooldowns</h3><p>Reads <code>Retry-After</code> and "try again in 2m59s". Per-minute limits rest a minute; per-day limits rest until the provider's reset.</p></div>
  <div class="card"><h3>Per-key and per-model rotation</h3><p>Keys are round-robin. Limits are usually per model, so a 429 falls to the next model on the same key first.</p></div>
  <div class="card"><h3>Failure classification</h3><p>A too-long prompt skips one provider for one call. Timeouts and 5xx trip a circuit breaker. A bad key leaves rotation alone.</p></div>
  <div class="card"><h3>Hard bounds</h3><p>Per-attempt timeout (idle timeout for streams) and a whole-call <code>deadlineMs</code>.</p></div>
  <div class="card"><h3>Parse-and-retry</h3><p>A response that fails your <code>parse</code> function counts as a provider failure and the next one is tried.</p></div>
  <div class="card"><h3>Visibility</h3><p><code>stats()</code>, <code>onAttempt</code>, <code>probe()</code> and a CLI answer "which key served what, and when does it reset?"</p></div>
</div>

<h2>Providers</h2>
<p>Generated from <code>src/providers.json</code> (version ${esc(pkg.version)}). Free tiers change without notice; read each provider's own console and terms before relying on a number here. Entries marked <em>tracker</em> or <em>unverified</em> come from third-party lists, not the provider's docs.</p>
<div class="tools">
  <input type="search" id="q" placeholder="Filter providers, models, notes" aria-label="Filter providers">
</div>
<p>${tierLegend}</p>
<div class="tablewrap">
<table id="providers">
<thead><tr><th>Tier</th><th>Provider</th><th>Models</th><th>Free tier</th><th>Sign up</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>

<h2>Check your own setup</h2>
<pre><code>npx llm-free-cascade keys            # which providers you're missing, and where to sign up
npx llm-free-cascade status          # order, keys, models, limits, warnings
npx llm-free-cascade probe --watch 300   # live check of every key, every 5 minutes</code></pre>

<footer>
  MIT licensed. Rotating across providers and models you already have keys for is the intended use; many providers forbid opening several free accounts to get around a limit, so read their terms. Generated ${esc(new Date().toISOString().slice(0, 10))}.
</footer>
</div>
<script>
(function(){
  var q=document.getElementById('q'),rows=document.querySelectorAll('#providers tbody tr');
  q.addEventListener('input',function(){
    var s=q.value.trim().toLowerCase();
    rows.forEach(function(r){r.style.display=!s||r.textContent.toLowerCase().indexOf(s)>-1?'':'none';});
  });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'docs', 'index.html'), html);
console.log(`wrote docs/index.html (${Object.keys(providers).length} providers)`);
