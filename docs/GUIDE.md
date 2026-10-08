# llm-free-cascade guide

The full reference. For the short version, see the [README](../README.md).

Contents: [Multi-turn](#multi-turn-conversations) · [Multiple keys](#multiple-free-keys-per-provider) · [JSON output](#json-output--parse-and-retry) · [Ordering](#choosing--reordering-providers) · [Models](#overriding-models-and-model-fallbacks) · [Cloudflare](#cloudflare-workers-ai) · [Gemini thinking](#gemini-disabling-thinking) · [Streaming](#streaming) · [Cooldowns](#provider-cooldown) · [Timeouts](#timeouts-and-deadlines) · [Errors](#errors) · [Cost and input hygiene](#cost-and-input-hygiene) · [Usage](#usage-reporting) · [Debugging](#debugging-fallbacks) · [Hooks](#live-model-overrides--observability-hooks) · [Stats, probe, CLI](#watching-what-the-cascade-does) · [Custom providers](#custom-providers-and-gateways) · [Provider table](#supported-providers) · [More keys](#get-more-free-keys)

## Multi-turn conversations

`user` is sugar for a single-turn message. For real chat history, pass
`messages` instead — an array of `{ role: 'user' | 'assistant', content }` —
and it's translated to whatever shape each provider's wire format expects
(Gemini's `contents`/`model` role, Anthropic's native `messages`, or the
OpenAI-compatible `messages` array everyone else uses):

```js
const { text } = await cascade.generate({
  system: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is the capital of Nepal?' },
    { role: 'assistant', content: 'Kathmandu.' },
    { role: 'user', content: 'And its population?' },
  ],
});
```

`messages` is validated strictly before anything is sent: roles must be
`user` or `assistant` (a client-supplied `system` turn is rejected, not
forwarded — your `system` prompt stays the only one), content must be a
non-empty string, the first turn must be `user`, and any extra fields are
dropped. A bad history rejects with an `INVALID_INPUT` error (status 400)
without touching a provider, so it can't put one on cooldown.

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

Keys are used round-robin, so successive calls start on different keys and a
burst is spread across them. A key that was just rate-limited (or rejected as
invalid) rests on its own cooldown and is skipped without spending a request,
instead of being retried first on every call.

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

The instance-level `order` is the default for every call; override it for a
single call instead by passing `order` to `generate()`. Providers without a
configured key are dropped, and it falls back to the instance's default order
if the override ends up empty:

```js
await cascade.generate({ system, user, order: ['cerebras', 'groq'] }); // just this call
```

## Overriding models, and model fallbacks

Free-tier model line-ups change without notice. Override per provider:

```js
const cascade = new LLMCascade({
  keys: { ... },
  models: { groq: 'llama-3.3-70b-versatile' }, // a string pins exactly this model
});
```

Most free tiers count limits **per model**, so one account has several
buckets. Groq, for instance, gives each of `gpt-oss-120b`, `gpt-oss-20b` and
`qwen3.8-27b` its own 1,000 requests/day. By default each provider tries its
`defaultModel` and then its `fallbackModels` from
[`providers.json`](../src/providers.json); a 429 on one falls to the next on the
same key before the cascade leaves the provider. Pass an array to choose the
list yourself:

```js
models: { groq: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'] }
```

A string (or a `modelResolver` result) is always used alone, with no fallbacks.
A model that has been retired (404) is dropped for every key, not retried once
per key per call.

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

## Gemini: disabling "thinking"

Gemini's flash models think by default, spending part of the output budget on
reasoning before it writes anything else — which can starve a short,
deterministic call (classification, tagging, a yes/no) into `MAX_TOKENS`
before it ever produces the answer. Pass `noThinking: true` to zero out its
thinking budget for calls that don't benefit from it. Every other provider
ignores the flag. Only set it for models that allow thinking to be disabled
(the `flash` and `flash-lite` lines) — the `pro` models reject a zero
budget with a 400, which counts as a provider failure:

```js
await cascade.generate({ system, user: 'Classify this as spam or not spam.', noThinking: true });
```

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

Rate-limit/quota failures (429) are **reset-aware**. The key+model that was
limited rests for as long as the provider says: its `Retry-After` header, or a
"try again in 2m59s" hint in the error text. With no hint, a message that
names a per-minute limit rests for a minute, and one that names a per-day
limit rests until the provider's daily reset (Gemini: midnight Pacific; where
there's no clock reset it is re-checked hourly). Only when every key and
model of a provider is spent does the provider itself leave the chain, until
the earliest of them recovers. That's what lets the chain wrap back around to
your fastest provider within a minute instead of ten.

To override all of that with one fixed number, set `rateLimitCooldownMs`:

```js
const cascade = new LLMCascade({
  keys: { ... },
  cooldownMs: 10 * 60 * 1000,     // structural failures (bad key, retired model, no content)
  rateLimitCooldownMs: 60 * 1000, // pin every 429 to a minute (turns the reset-aware logic off)
});
```

Other failures are told apart too:

- A prompt that is **too long** for one provider's context window (HTTP 400/413)
  skips that provider for this call only. It no longer benches it for everyone.
- **Timeouts, dropped connections and 5xx** trip a circuit breaker after two in
  a row (`breakerMs`, default 60 s; `0` disables), so a dead provider costs one
  timeout, not one per call.
- A **401/403** takes only that key out of rotation.

> **Cost note.** If you put a paid provider (e.g. `anthropic`) at the end of
> the chain, remember that a cooldown on every free provider routes *all*
> traffic to the paid one until the cooldown expires. Keep
> `rateLimitCooldownMs` short and set `maxTokensLimit` (below) if that's a
> concern.

To end a cooldown early — e.g. after your own out-of-band health check
confirms a provider is back — call `clearCooldown(provider)` instead of
waiting out the rest of `cooldownMs`/`rateLimitCooldownMs`:

```js
await cascade.clearCooldown('groq');
```

Provider-level cooldown state lives in an in-memory `Map` by default, which is
per-process. (Per-key and per-model rests are always in-process: a key's
position in the list only means something inside the instance that holds the
list.) If you're running multiple instances/serverless invocations and want
them to share provider cooldown state, pass a `cooldownStore` — anything with a `get(provider)`
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

A fast provider can be given a shorter leash than a slow one with
`providerTimeoutMs` (a `timeoutMs` passed to `generate()` still wins):

```js
const cascade = new LLMCascade({ keys: { ... }, providerTimeoutMs: { groq: 10_000, cerebras: 10_000 } });
```

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
| `code` | `ALL_PROVIDERS_FAILED`, `ALL_RATE_LIMITED` (every failure was a 429), `DEADLINE_EXCEEDED`, `INVALID_INPUT` (bad `messages`/missing `user` — thrown before any provider is called), or `null` (no provider configured) |
| `statusCode` | a suggested HTTP status for the caller: 502, 429, 504, 400, or 503 respectively |
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

`timeoutMs` has no such cap — don't take it from untrusted input. The same
goes for the per-call `order`: a client that can choose the chain can route
its own request straight to your paid last-resort provider, so decide the
order server-side. `messages` *is* designed to be built from a client's
history — it's validated and rebuilt (see "Multi-turn conversations") — but
its total length isn't capped here, so bound it in your app if input-token
cost matters.

Note that any HTTP 4xx from a provider (once every key for it has been
tried) puts that provider on cooldown, since a bad model name or a revoked
key will recur for every call. A request-specific 400 — e.g. a history that
exceeds the model's context window — triggers the same cooldown, so keep
per-request inputs within limits the provider will accept.

## Usage reporting

`generate()` returns a `usage` field alongside `text`/`provider` whenever the
winning provider reports token counts (most do; it's `undefined` when one
doesn't):

```js
const { text, provider, usage } = await cascade.generate({ system, user });
console.log(usage); // { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
```

When `providers.json` has a known list price for the winning provider,
`generate()` also returns an approximate `shadowCostUsd` — what this call
would have cost had it gone to a paid tier, for cost-awareness dashboards.
It's `undefined` whenever usage or a known price isn't available (most free
providers here have no meaningful paid comparison), and it's an estimate at
time of writing, not a real charge:

```js
const { usage, shadowCostUsd } = await cascade.generate({ system, user });
console.log(shadowCostUsd); // e.g. 0.0000075, or undefined
```

## Debugging fallbacks

Every result — streaming or not — includes `attempts`: the providers tried
and skipped *before* the one that succeeded, each with its (redacted)
failure message. Empty when the first provider tried succeeded:

```js
const { provider, attempts } = await cascade.generate({ system, user });
if (attempts.length) console.log(`fell back past ${attempts.map((a) => a.provider).join(', ')} to reach ${provider}`);
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

## Watching what the cascade does

Everything below is in-process: a second process has its own numbers. Key
material is never included, keys show up as `#0`, `#1`, … by position.

**`cascade.stats()`** is a snapshot since the instance was created. Per
provider it has calls / successes / 429s / timeouts, latency (EWMA, p50, p95),
tokens, the last error, per-model and per-key counters, the provider's
remaining cooldown, and `usableInMs` (0 means usable now):

```js
const { providers } = await cascade.stats();
console.table(Object.entries(providers).map(([name, p]) => ({
  provider: name, calls: p.calls, ok: p.ok, '429s': p.rateLimited,
  p50: p.latencyMs.p50, usableInMs: p.usableInMs,
})));
```

**`onAttempt`** fires after every single HTTP attempt (every key × model
tried), which is the right hook for a log line or a metrics counter:

```js
const cascade = new LLMCascade({
  keys: { ... },
  onAttempt: ({ provider, model, keyIndex, ok, ms, kind, error }) =>
    logger.info('llm attempt', { provider, model, keyIndex, ok, ms, kind, error }),
});
```

**`cascade.probe()`** sends one tiny request through every configured key (one
at a time) and tells you who answered. Run it at deploy time, or on a
schedule, to catch a revoked key or a retired default model before a user
does. It spends a little real quota per key and never changes cooldowns.

**CLI** (reads the same environment variables as `fromEnv()`):

```bash
npx llm-free-cascade status                 # order, keys, models, free-tier limits, warnings
npx llm-free-cascade probe                  # live check of every key
npx llm-free-cascade probe --watch 300      # ...repeated every 5 minutes (spends quota each round)
npx llm-free-cascade probe --provider groq  # only some providers; add --json for machine output
```

**Order by speed** (opt-in): `adaptiveOrder: true` reorders providers *within the
same tier* by observed latency and success rate, once there are enough
samples. Tiers are in `providers.json`, so a paid provider never jumps ahead
of a free one.

From a checkout, `npm run check:providers` asks each provider's model-list
endpoint (no tokens, no quota) whether the default and fallback models still
exist. OpenRouter, ModelScope, OVHcloud, LLM7 and Pollinations list models
without a key; for the others it uses the key from your environment.

## Custom providers and gateways

Any OpenAI-compatible endpoint can join the chain without a code change: a
self-hosted gateway such as [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
or LiteLLM, a community router, or a provider that isn't in `providers.json` yet.

```js
const cascade = new LLMCascade({
  keys: { groq: process.env.GROQ_API_KEY },
  custom: {
    omniroute: {
      baseUrl: 'http://localhost:20128/v1', // requests go to <baseUrl>/chat/completions
      models: ['auto/best-free'],
      apiKey: process.env.OMNIROUTE_KEY,
      tier: 4,                               // where it sits in the default order (1 first … 5 last)
    },
  },
});
```

Or from the environment: `LLM_CUSTOM_PROVIDERS='{"omniroute":{"baseUrl":"…","model":"…","apiKey":"…"}}'`.
A custom provider takes part in everything else (key rotation, model
fallback, cooldowns, `order`, `stats()`). `baseUrl` must be `https://` (plain
`http://` is accepted only for localhost), and a custom provider cannot reuse
a built-in name or set `Authorization`/`Host` headers.

To point a *built-in* provider elsewhere — your own proxy, or the China
endpoint for Zhipu (a key from `open.bigmodel.cn` does not work on the
international `api.z.ai`) — use `baseUrls` or `<PROVIDER>_BASE_URL`:

```js
new LLMCascade({ keys: { zhipu: key }, baseUrls: { zhipu: 'https://open.bigmodel.cn/api/paas/v4' } });
```

> **A gateway is not a free lunch.** OmniRoute and similar tools hold *every*
> key you give them, so put a password on them (OmniRoute's default dashboard
> password is the literal `CHANGEME`) and don't expose the port. Some of their
> "free" sources are reused consumer-subscription logins or unofficial pools:
> check those providers' terms before relying on them. This package already
> does key rotation, fallback and cooldowns, so a gateway in front of it mostly
> adds a second layer that argues with the first. It is most useful as one late
> tier, or for discovering which obscure free providers currently work.

## Supported providers

[`src/providers.json`](../src/providers.json) is the single source of truth for
every provider this package knows about — base URL, default and fallback
models, tier, free-tier limits, the env var it reads, and where to sign up. It's
a plain JSON file specifically so that fixing a retired model name, or adding
a brand-new free-tier provider, is a one-file pull request that doesn't
require touching any dispatch logic (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
The default order is the file's order, sorted by **tier** (1 = fast and roomy,
5 = paid last resort).

| Tier | Provider | Env var | Free tier (see `providers.json` for sources) |
|---|---|---|---|
| 1 | Groq | `GROQ_API_KEY` | console.groq.com. Per model: 30 RPM, 1K req/day, 200K tokens/day, per organization |
| 1 | Google Gemini | `GEMINI_API_KEY` | aistudio.google.com. Per project and per model, daily reset at midnight Pacific; free prompts may train Google's models |
| 1 | Cerebras | `CEREBRAS_API_KEY` | inference.cerebras.ai. Now a **$5 trial that expires in 30 days** |
| 2 | Mistral | `MISTRAL_API_KEY` | console.mistral.ai. ~1 req/s, big monthly pool; phone + data-training opt-in |
| 2 | NVIDIA NIM | `NVIDIA_API_KEY` | build.nvidia.com. ~40 RPM, prototyping only |
| 2 | Z.ai (Zhipu) | `ZHIPU_API_KEY` | z.ai. GLM-4.7-Flash / 4.5-Flash free, no expiry |
| 3 | OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai. `:free` models: 20 RPM, **50 req/day** (1,000 after a $10 top-up), enforced globally: extra accounts don't help |
| 3 | SiliconFlow | `SILICONFLOW_API_KEY` | siliconflow.com. A few small models free; China-hosted |
| 3 | ModelScope | `MODELSCOPE_API_KEY` | modelscope.cn. ~2,000 req/day; China-hosted, may need a phone |
| 3 | Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com. 10K neurons/day, small context |
| 3 | Hugging Face | `HUGGINGFACE_API_KEY` | huggingface.co/settings/tokens. Only ~$0.10/month now |
| 3 | Cohere | `COHERE_API_KEY` | dashboard.cohere.com/api-keys. **Non-commercial only** |
| 4 | Together AI | `TOGETHER_API_KEY` | api.together.xyz. Signup credit only |
| 4 | SambaNova | `SAMBANOVA_API_KEY` | cloud.sambanova.ai. Trial; payment method now required |
| 4 | Pollinations | `POLLINATIONS_API_KEY` | auth.pollinations.ai. Anonymous at 1 req/15s, but the cascade only includes a provider it has a key for |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | opencode.ai/zen |
| 4 | OVHcloud AI Endpoints | `OVH_AI_ENDPOINTS_API_KEY` | endpoints.ai.cloud.ovh.net. EU-hosted, ~12 RPM |
| 4 | LLM7 | `LLM7_API_KEY` | token.llm7.io. Free tier **unverified** (its model list shows prices) |
| 5 | DeepSeek (paid) | `DEEPSEEK_API_KEY` | platform.deepseek.com. Cheapest sensible paid fallback |
| 5 | Anthropic (paid) | `ANTHROPIC_API_KEY` | console.anthropic.com |

Free tiers, model names, and pricing change over time — this table (and
`providers.json`) reflect the state on 2026-10-07 (each entry's `verifiedAt`),
not a live feed. Several providers cut or ended their free tiers in 2026
(Cerebras, SambaNova, GitHub Models, Chutes). Where `limitsSource` is
`tracker` or `unverified`, the numbers came from a third-party list, not the
provider's own docs: read your own console before relying on them. Override
`models`/`order` at runtime, or send a PR updating `providers.json`, as
providers change their line-up.

## Get more free keys

The library doesn't hand out keys itself — but it knows where to send you.
Run the bundled CLI to see which providers you're missing and go sign up:

```bash
npx llm-free-cascade keys
```

Prints a ✓/✗ table against your current environment, and for anything
missing, the signup URL, a one-line note on the free tier, and flags that
matter before you sign up (needs a phone or card, trial only, non-commercial,
may train on your prompts, China-hosted). Two optional flags:

```bash
npx llm-free-cascade keys --open   # opens every missing provider's signup page in your browser
npx llm-free-cascade keys --env    # appends a commented-out line per missing var to ./.env
```

This never creates accounts or signs anything up for you — it only opens
pages and writes placeholder lines you fill in yourself. It's driven by
[`src/providers.json`](../src/providers.json) at runtime (also exported as
`PROVIDER_INFO`), so a provider added there later shows up in the CLI with
no code changes.

### Scaling past one free-tier account

Most free tiers are rate-limited **per account** (Gemini: per project, Groq:
per organization), so a second key can double your headroom. In order of
preference:

1. **Use every model bucket first.** Limits are usually per model (see
   "model fallbacks"), so the default `fallbackModels` already multiply one
   account's capacity at no risk.
2. **Add more providers.** Each is an independent allowance.
3. **Then add a second account** where it helps: another Gemini *project*, a
   second Groq organization. Add the key to the same provider's list and the
   cascade rotates through them.

Know the limits of this: OpenRouter enforces its limit globally per user and
says extra accounts or keys don't raise it; Mistral and NVIDIA need a phone
number per account; and many providers' terms forbid opening several free
accounts to get around a limit, usually punished by banning all of them. This
package does not check that for you: read each provider's terms first.
