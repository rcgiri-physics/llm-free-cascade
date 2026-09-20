# llm-free-cascade

Call an LLM without paying for it. `llm-free-cascade` tries a chat completion
across a chain of providers — Gemini, Groq, Cerebras, SambaNova, Mistral,
OpenRouter, Together AI, DeepSeek, Cohere, Hugging Face, Cloudflare Workers
AI, Z.ai (Zhipu), NVIDIA NIM, and OpenCode Zen all have (or had) a usable
free tier — and falls through to the next one whenever the current one is
rate-limited, out of quota, or errors.
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
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID, // 32-char hex, as shown in the dashboard
});
```

The account ID is spliced into a URL path, so it's validated as a 32-character
hex string and anything else is rejected before a request is made.

## Streaming

Pass `stream: true` to get chunks back as they arrive instead of waiting for
the full response. `generate()` returns `{ stream, provider }` — a distinct
shape from the non-streaming `{ text, ... }` result — where `stream` is an
async iterable of text chunks:

```js
const { stream, provider } = await cascade.generate({ system, user, stream: true });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

Fallback only happens *before* the first chunk arrives — a provider that
errors immediately (bad key, HTTP error) still falls through to the next one
in the chain, same as non-streaming. Once a chunk has been yielded to you,
there's no further fallback (there's no way to un-send partial output).
Stopping the loop early (`break`) or letting it throw always releases the
underlying stream reader — nothing is left dangling.

## Provider cooldown

If a provider fails with a structural error (bad model name, no content, any
HTTP 4xx once every key for it has been tried) it's put on a cooldown
(default 10 minutes, configurable via `cooldownMs`) so a busy loop doesn't
hammer a broken provider on every call. The last provider still standing is
never cooled down — there'd be nothing left to try.

Rate-limit/quota failures (429) get their own knob, `rateLimitCooldownMs`,
which defaults to `cooldownMs`. Set it lower when your providers' limits are
per-minute rather than per-day:

```js
const cascade = new LLMCascade({
  keys: { ... },
  cooldownMs: 10 * 60 * 1000,     // structural failures
  rateLimitCooldownMs: 60 * 1000, // 429s: try again after a minute
});
```

> **Cost note.** If you put a paid provider (e.g. `anthropic`) at the end of
> the chain, remember that a cooldown on every free provider routes *all*
> traffic to the paid one until the cooldown expires. Keep
> `rateLimitCooldownMs` short and set `maxTokensLimit` (below) if that's a
> concern.

Cooldown state lives in an in-memory `Map` by default, which is per-process.
If you're running multiple instances/serverless invocations and want them to
share cooldown state, pass a `cooldownStore` — anything with a `get(provider)`
and `set(provider, until)` (sync or async, e.g. backed by Redis). An optional
`getMany(providers)` lets a remote store answer for the whole chain in one
round-trip instead of one `get` per provider:

```js
const cascade = new LLMCascade({
  keys: { ... },
  cooldownStore: {
    get: (provider) => redis.get(`cooldown:${provider}`),
    set: (provider, until) => redis.set(`cooldown:${provider}`, until),
    getMany: (providers) => redis.mget(providers.map((p) => `cooldown:${p}`)), // optional
  },
});
```

## Timeouts and deadlines

Free-tier endpoints occasionally hang instead of erroring. Every attempt has
a timeout (default 30s) after which it's treated as a normal per-provider
failure — the cascade just moves to the next provider, same as a 429 or 500:

```js
const cascade = new LLMCascade({ keys: { ... }, timeoutMs: 8000 });
// or per call:
await cascade.generate({ system, user, timeoutMs: 8000 });
```

The timeout covers the whole exchange — connect, headers, *and* reading the
body — so a provider that returns `200 OK` and then stalls can't hang a call.
For streams it's the time-to-first-byte, and then an **idle** timeout that's
re-armed after every chunk: a long generation that keeps producing tokens is
never cut off, but one that goes quiet mid-way fails with a `timed out`
error. Non-positive or non-numeric values fall back to the default.

Per-attempt timeouts still let a bad day add up (15 providers × 30s). To
bound the *whole* call, set `deadlineMs`. Each attempt gets the smaller of
`timeoutMs` and whatever's left, and once the budget is spent the cascade
throws a `DEADLINE_EXCEEDED` error (status 504) instead of trying the rest:

```js
const cascade = new LLMCascade({ keys: { ... }, timeoutMs: 10_000, deadlineMs: 25_000 });
```

## Errors

When every provider in the chain has failed, `generate()` rejects with an
`LLMCascadeError`:

| field | meaning |
|---|---|
| `code` | `ALL_PROVIDERS_FAILED`, `ALL_RATE_LIMITED` (every failure was a 429), `DEADLINE_EXCEEDED`, or `null` (no provider configured) |
| `statusCode` | a suggested HTTP status for the caller: 502, 429, 504, or 503 respectively |
| `failures` | `[{ provider, message }]`, one per provider attempted, in order — redacted (see below) |
| `message` | a one-line summary joining all `failures` |

`statusCode` and `code` are safe to forward to an HTTP client. `message` and
`failures` are meant for your logs: they name your providers and models and
carry each provider's own error text (capped at 2 KB per provider), which
isn't something an end user needs to see.

## Cost and input hygiene

If `generate()`'s parameters come from an untrusted request (a browser, a
public API), clamp them. `maxTokensLimit` caps `maxTokens` for every call
regardless of what the caller asked for, and anything non-numeric or
non-positive falls back to the default (1024):

```js
const cascade = new LLMCascade({ keys: { ... }, maxTokensLimit: 2048 });
await cascade.generate({ system, user, maxTokens: 1_000_000 }); // sent as 2048
```

`timeoutMs` has no such cap — don't take it from untrusted input.

## Usage reporting

`generate()` returns a `usage` field alongside `text`/`provider` whenever the
winning provider reports token counts (most do; it's `undefined` when one
doesn't):

```js
const { text, provider, usage } = await cascade.generate({ system, user });
console.log(usage); // { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
```

## Live model overrides & observability hooks

For callers that resolve a model dynamically (e.g. from a DB-backed admin
panel) instead of pinning it at construction time, pass `modelResolver`. It's
checked before every attempt and falls back to the static `models` map (or
the built-in default) when it returns `null`/`undefined` or throws:

```js
const cascade = new LLMCascade({
  keys: { ... },
  modelResolver: (provider) => getAdminOverride(provider), // return null/undefined to use the default
});
```

`onProviderFailure`/`onProviderCooldown` let you hook logging into the
cascade without wrapping `generate()` yourself. Messages passed to them (and
included in the thrown `LLMCascadeError`) are redacted: every key the cascade
holds is scrubbed by literal value (so it doesn't matter how the provider
phrased its error), then anything else that looks like a credential is
masked by pattern. The same function is exported as
`redact(message, secrets?)` for your own log lines:

```js
const cascade = new LLMCascade({
  keys: { ... },
  onProviderFailure: (provider, message) => logger.debug(`${provider} failed`, { message }),
  onProviderCooldown: (provider, cooldownMs) => logger.warn(`${provider} cooling down for ${cooldownMs}ms`),
});
```

`cascade.getLiveOrder()` returns the current provider chain with anything on
cooldown filtered out — useful for a status page or admin UI.

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
| Z.ai (Zhipu) | `ZHIPU_API_KEY` | open.bigmodel.cn |
| NVIDIA NIM | `NVIDIA_API_KEY` | build.nvidia.com |
| OpenCode Zen | `OPENCODE_API_KEY` | opencode.ai/zen |
| Anthropic (paid, last resort) | `ANTHROPIC_API_KEY` | console.anthropic.com |

Free tiers, model names, and pricing change over time — this table (and
`providers.json`) reflect the state at time of writing, not a live feed.
Override `models`/`order` at runtime, or send a PR updating `providers.json`,
as providers change their line-up.

## Get more free keys

The library doesn't hand out keys itself — but it knows where to send you.
Run the bundled CLI to see which providers you're missing and go sign up:

```bash
npx llm-free-cascade keys
```

Prints a ✓/✗ table against your current environment, and for anything
missing, the signup URL and a one-line note on the free tier. Two optional
flags:

```bash
npx llm-free-cascade keys --open   # opens every missing provider's signup page in your browser
npx llm-free-cascade keys --env    # appends a commented-out line per missing var to ./.env
```

This never creates accounts or signs anything up for you — it only opens
pages and writes placeholder lines you fill in yourself. It's driven by
[`src/providers.json`](src/providers.json) at runtime (also exported as
`PROVIDER_INFO`), so a provider added there later shows up in the CLI with
no code changes.

### Scaling past one free-tier account

Free tiers are almost always rate-limited **per account**, not per app. If
you hit a wall, the built-in fix isn't a new provider — it's another account
on the same one: sign up again with a different email, grab a second key, and
add it to the same provider's key list (see "Multiple free keys per provider"
above). The cascade rotates through them automatically before giving up on
that provider.

## License

MIT
