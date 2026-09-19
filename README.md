# llm-free-cascade

Call an LLM without paying for it. `llm-free-cascade` tries a chat completion
across a chain of providers — Gemini, Groq, Cerebras, SambaNova, Mistral,
OpenRouter, Together AI, DeepSeek, Cohere, Hugging Face, and Cloudflare
Workers AI all have (or had) a usable free tier — and falls through to the
next one whenever the current one is rate-limited, out of quota, or errors.
An optional paid provider (Anthropic) can sit at the end of the chain as a
last resort.

Zero dependencies. Node 18+ (uses global `fetch`).

## Install

```bash
npm install llm-free-cascade
```

## Quick start

```js
const { LLMCascade } = require('llm-free-cascade');

const cascade = new LLMCascade({
  keys: {
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    cerebras: process.env.CEREBRAS_API_KEY,
  },
});

const { text, provider } = await cascade.generate({
  system: 'You are a helpful assistant.',
  user: 'Explain photosynthesis in one sentence.',
});

console.log(provider, text);
```

Or build it straight from environment variables, using the same names as the
providers' own docs (`GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, …):

```js
const cascade = LLMCascade.fromEnv();
```

## Multiple free keys per provider

Free tiers are usually rate-limited per account, not per app. If you've made
several free accounts for the same provider, supply all their keys and the
cascade rotates through them before giving up on that provider:

```js
const cascade = new LLMCascade({
  keys: { gemini: [key1, key2, key3] },
});
```

`fromEnv()` supports the same thing via comma-separated or numbered env vars:

```bash
GEMINI_API_KEY=key1,key2
# or
GEMINI_API_KEY=key1
GEMINI_API_KEY_2=key2
GEMINI_API_KEY_3=key3
```

## JSON output + parse-and-retry

Pass `json: true` to request each provider's native JSON mode, and a `parse`
function to validate the output. If `parse` throws, that provider's response
is treated as a failure and the cascade moves to the next provider instead of
returning malformed data — useful because free-tier models occasionally wrap
JSON in markdown fences or emit invalid escapes.

```js
const { text, parsed, provider } = await cascade.generate({
  system: 'Return ONLY JSON: { "answer": string }',
  user: 'What is the capital of Nepal?',
  json: true,
  parse: (text) => {
    const obj = JSON.parse(text); // or use the bundled parseJsonLoose(text)
    if (typeof obj.answer !== 'string') throw new Error('bad shape');
    return obj;
  },
});
```

## Choosing / reordering providers

```js
const cascade = new LLMCascade({
  keys: { ... },
  order: ['groq', 'cerebras', 'gemini'], // only these three, in this order
});
```

`fromEnv()` also reads `LLM_PROVIDER_ORDER` (comma-separated) for the same effect.

## Overriding models

Free-tier model line-ups change without notice. Override per provider:

```js
const cascade = new LLMCascade({
  keys: { ... },
  models: { groq: 'llama-3.3-70b-versatile' },
});
```

## Cloudflare Workers AI

Cloudflare's base URL is per-account, so it needs one extra field:

```js
const cascade = new LLMCascade({
  keys: { cloudflare: process.env.CLOUDFLARE_API_TOKEN },
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
});
```

## Provider cooldown

If a provider fails with a structural error (bad model name, no content,
unknown provider) it's put on a cooldown (default 10 minutes, configurable
via `cooldownMs`) so a busy loop doesn't hammer a broken provider on every
call. Transient errors (a single bad request, one rate-limited call) don't
trigger a cooldown — they just move on to the next provider for that call.

## Supported providers

[`src/providers.json`](src/providers.json) is the single source of truth for
every provider this package knows about — base URL, default model, the env
var it reads, and where to sign up for the free tier. It's a plain JSON file
specifically so that fixing a retired model name, or adding a brand-new
free-tier provider, is a one-file pull request that doesn't require touching
any dispatch logic (see [CONTRIBUTING.md](CONTRIBUTING.md)).

| Provider | Env var | Free tier |
|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | aistudio.google.com |
| Groq | `GROQ_API_KEY` | console.groq.com |
| Cerebras | `CEREBRAS_API_KEY` | inference.cerebras.ai |
| SambaNova | `SAMBANOVA_API_KEY` | cloud.sambanova.ai |
| Mistral | `MISTRAL_API_KEY` | console.mistral.ai |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai (has `:free` model slugs) |
| Together AI | `TOGETHER_API_KEY` | api.together.xyz (signup credit) |
| DeepSeek | `DEEPSEEK_API_KEY` | platform.deepseek.com |
| Cohere | `COHERE_API_KEY` | dashboard.cohere.com/api-keys |
| Hugging Face | `HUGGINGFACE_API_KEY` | huggingface.co/settings/tokens |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com |
| Anthropic (paid, last resort) | `ANTHROPIC_API_KEY` | console.anthropic.com |

Free tiers, model names, and pricing change over time — this table (and
`providers.json`) reflect the state at time of writing, not a live feed.
Override `models`/`order` at runtime, or send a PR updating `providers.json`,
as providers change their line-up.

### Scaling past one free-tier account

Free tiers are almost always rate-limited **per account**, not per app. If
you hit a wall, the built-in fix isn't a new provider — it's another account
on the same one: sign up again with a different email, grab a second key, and
add it to the same provider's key list (see "Multiple free keys per provider"
above). The cascade rotates through them automatically before giving up on
that provider.

## License

MIT
