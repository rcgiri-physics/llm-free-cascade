#!/usr/bin/env node
'use strict';

/**
 * Trial harness for Jev (TypeSafe AI, https://typesafe.ai): does it agree
 * with the free-LLM cascade on classification-style calls, and is it faster?
 * Jev doesn't generate text; it answers typed questions about some text, so
 * it can only replace the "classify / screen / verify" calls, not generation.
 *
 *   TYPESAFE_API_KEY=... GROQ_API_KEY=... node scripts/jev-compare.js cases.jsonl
 *
 * Each line of the JSONL file is one case:
 *   {"id":"q1","state":"<the text>","instructions":"Which Bloom level is this question?",
 *    "criteria":{"1":"Knowledge (recall)","2":"Comprehension","3":"Application"},
 *    "expected":"2"}                      <- optional hand label
 *
 * For every case it asks Jev (POST https://api.typesafe.ai/v1/systemone, a
 * "choice" question) and the cascade (same labels, JSON answer), then reports
 * Jev-vs-cascade agreement, each one's accuracy against `expected` where you
 * gave it, latency, and Jev's confidence on the cases they disagree about.
 * Both services are billed/limited on their own terms: start with ~50 cases.
 * Request shape taken from docs.typesafe.ai (quickstart); if it has changed,
 * adjust `askJev` below.
 */

const fs = require('fs');
const { LLMCascade, parseJsonLoose } = require('../src/index.js');

const JEV_URL = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';

async function askJev(apiKey, c) {
  const started = Date.now();
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      state: c.state,
      model: 'jev-latest',
      questions: { answer: { type: 'choice', instructions: c.instructions, criteria: c.criteria } },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}`);
  const answer = (await res.json()).answers?.answer;
  return { choice: String(answer?.choice), confidence: answer?.confidence, ms: Date.now() - started };
}

async function askCascade(cascade, c) {
  const labels = Object.entries(c.criteria).map(([k, v]) => `${k} = ${v}`).join('\n');
  const started = Date.now();
  const { parsed, provider } = await cascade.generate({
    system: `${c.instructions}\nChoose exactly one label:\n${labels}\nReturn ONLY JSON: {"choice": "<label>"}`,
    user: c.state,
    json: true,
    noThinking: true,
    maxTokens: 64,
    parse: (text) => {
      const obj = parseJsonLoose(text);
      if (!obj || !Object.hasOwn(c.criteria, String(obj.choice))) throw new Error('not a valid label');
      return obj;
    },
  });
  return { choice: String(parsed.choice), provider, ms: Date.now() - started };
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

async function main() {
  const file = process.argv[2];
  const jevKey = process.env.TYPESAFE_API_KEY;
  if (!file || !jevKey) {
    console.error('Usage: TYPESAFE_API_KEY=... <provider keys> node scripts/jev-compare.js cases.jsonl');
    process.exit(2);
  }
  const cases = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cascade = LLMCascade.fromEnv();

  const rows = [];
  for (const c of cases) {
    const row = { id: c.id, expected: c.expected == null ? undefined : String(c.expected) };
    try { row.jev = await askJev(jevKey, c); } catch (e) { row.jevError = e.message; }
    try { row.llm = await askCascade(cascade, c); } catch (e) { row.llmError = e.message; }
    rows.push(row);
  }

  const both = rows.filter((r) => r.jev && r.llm);
  const agree = both.filter((r) => r.jev.choice === r.llm.choice);
  const labelled = rows.filter((r) => r.expected !== undefined);
  const correct = (who) => labelled.filter((r) => r[who] && r[who].choice === r.expected).length;

  console.log(`\ncases: ${rows.length}   Jev errors: ${rows.filter((r) => r.jevError).length}   cascade errors: ${rows.filter((r) => r.llmError).length}`);
  console.log(`agreement (both answered): ${agree.length}/${both.length} = ${pct(agree.length, both.length)}`);
  if (labelled.length) {
    console.log(`accuracy vs your labels (${labelled.length}):  Jev ${pct(correct('jev'), labelled.length)}   cascade ${pct(correct('llm'), labelled.length)}`);
  }
  console.log(`median latency:  Jev ${median(rows.filter((r) => r.jev).map((r) => r.jev.ms))} ms   cascade ${median(rows.filter((r) => r.llm).map((r) => r.llm.ms))} ms`);
  const disagreements = both.filter((r) => r.jev.choice !== r.llm.choice);
  if (disagreements.length) {
    console.log('\nwhere they disagree (look at these by hand):');
    for (const r of disagreements.slice(0, 20)) {
      console.log(`  ${r.id}: Jev=${r.jev.choice} (conf ${r.jev.confidence?.toFixed?.(2)})  cascade=${r.llm.choice} [${r.llm.provider}]${r.expected !== undefined ? `  yours=${r.expected}` : ''}`);
    }
  }
  console.log('\nAdopt Jev only if accuracy is at least the cascade\'s, latency is clearly lower, and its confidence is useful for routing doubtful cases to a human.\n');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
