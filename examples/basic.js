// node examples/basic.js
// Requires at least one of GEMINI_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY etc. set.
'use strict';

const { LLMCascade } = require('../src/index.js');

async function main() {
  const cascade = LLMCascade.fromEnv();

  const { text, provider } = await cascade.generate({
    system: 'You are a concise assistant.',
    user: 'Name one free-tier LLM API in one sentence.',
    maxTokens: 200,
  });

  console.log(`[${provider}]`, text);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
