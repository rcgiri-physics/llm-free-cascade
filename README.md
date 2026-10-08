# llm-free-cascade

**Your app shouldn't die because Groq returned a 429.**

`llm-free-cascade` sends one chat completion through a chain of LLM providers
that have a free tier, and falls through to the next one when the current one
is rate-limited, out of quota, slow or down. It reads *why* a call failed, so a
rate-limited key rests for exactly as long as the provider says, and a limit
that is per model falls to the next model on the same key before leaving the
provider.

Zero dependencies. Node 18+. One `generate()` call, 20 providers known out of the box.

```js
const { LLMCascade } = require('llm-free-cascade');

const cascade = LLMCascade.fromEnv(); // GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, ...

const { text, provider, attempts } = await cascade.generate({
  system: 'You are a helpful assistant.',
  user: 'Explain photosynthesis in one sentence.',
});
// provider -> whichever one answered; attempts -> who it skipped, and why
```

```bash
npm install llm-free-cascade
```

## What it does that a plain retry loop doesn't

- **Reset-aware cooldowns.** Reads `Retry-After` and "try again in 2m59s" text.
  A per-minute limit rests for a minute, a per-day limit until the provider's
  reset (Gemini: midnight Pacific). The chain wraps back to your fastest
  provider quickly instead of benching it for ten minutes.
- **Per-key and per-model rotation.** Several keys per provider are used
  round-robin. Limits are usually per model, so a 429 on one model falls to the
  next on the same key first.
- **Failure classification.** A prompt that is too long skips one provider for
  one call. Timeouts and 5xx trip a circuit breaker. A bad key leaves rotation
  alone, without benching the provider.
- **Hard bounds.** Per-attempt `timeoutMs` (idle timeout for streams) and a
  whole-call `deadlineMs`.
- **Parse-and-retry.** Pass `json: true` and a `parse` function. A response that
  fails to parse counts as a provider failure and the next one is tried.
- **Streaming**, multi-turn `messages`, token `usage`, `shadowCostUsd`, and a
  paid last-resort provider (DeepSeek, Anthropic) at the end of the chain.
- **Custom providers.** Any OpenAI-compatible endpoint (a self-hosted gateway,
  LiteLLM, OmniRoute) joins the chain with one config entry.
- **Visibility.** `stats()`, `onAttempt`, `probe()` and a CLI, so you can answer
  "which key served what today, and when does it reset?"

## See what it's doing

```text
$ npx llm-free-cascade status

llm-free-cascade — 5 provider(s) configured, in this order:

   1. groq         2 key(s)  [tier 1]
      models: openai/gpt-oss-120b -> qwen/qwen3.8-27b -> openai/gpt-oss-20b
      limits: 30 RPM, 1000 RPD, 8000 TPM, 200000 TPD, per model, per organization
   2. gemini       1 key(s)  [tier 1, may train on your prompts]
      models: gemini-3.6-flash
   3. cerebras     1 key(s)  [tier 1, trial/credit, not a standing free tier, needs card]
      models: gpt-oss-120b -> qwen-3.8-27b
   ...
```

```bash
npx llm-free-cascade probe                  # one tiny live request through every key
npx llm-free-cascade probe --watch 300      # ...repeated every 5 minutes
npx llm-free-cascade keys                   # which providers you're missing, and where to sign up
```

## Common recipes

```js
// Several keys for one provider (or GEMINI_API_KEY=key1,key2 in the environment)
new LLMCascade({ keys: { gemini: [key1, key2] } });

// Pick and order the chain
new LLMCascade({ keys: { ... }, order: ['groq', 'cerebras', 'gemini'] });

// Bound latency: 8 s per attempt, 25 s for the whole call
new LLMCascade({ keys: { ... }, timeoutMs: 8000, deadlineMs: 25_000 });

// Multi-turn chat
await cascade.generate({ system, messages: [{ role: 'user', content: 'Hi' }] });

// Streaming
const { stream } = await cascade.generate({ system, user, stream: true });
for await (const chunk of stream) process.stdout.write(chunk);

// Add a gateway or any other OpenAI-compatible endpoint
new LLMCascade({ keys: { ... }, custom: { mygw: { baseUrl: 'https://gw.example/v1', models: ['auto'], apiKey } } });
```

When every provider fails, `generate()` rejects with an `LLMCascadeError`
carrying `code`, a suggested `statusCode` and redacted `failures`.

## Providers

Groq, Google Gemini, Cerebras, Mistral, NVIDIA NIM, Z.ai (Zhipu), OpenRouter,
SiliconFlow, ModelScope, Cloudflare Workers AI, Hugging Face, Cohere, Together,
SambaNova, Pollinations, OpenCode Zen, OVHcloud, LLM7, plus DeepSeek and
Anthropic as paid fallbacks. The full table with limits, caveats and signup
links is on the [project page](https://rcgiri-physics.github.io/llm-free-cascade/)
and in the [guide](docs/GUIDE.md#supported-providers).

Free tiers change without notice (Cerebras, SambaNova and GitHub Models all cut
theirs in 2026), so each entry in [`src/providers.json`](src/providers.json)
records `verifiedAt` and where its numbers came from. Read a provider's own
terms before relying on it, and before opening several free accounts to get
around a limit: many providers forbid that. Rotating across providers and
models you already have keys for is the intended use.

## Documentation

- **[Guide](docs/GUIDE.md)**: every option, in depth (cooldowns, timeouts,
  errors, hooks, stats, custom providers, cost and input hygiene).
- **[Project page](https://rcgiri-physics.github.io/llm-free-cascade/)**: the
  provider table, generated from `providers.json`.
- **[Changelog](CHANGELOG.md)** · **[Contributing](CONTRIBUTING.md)**: fixing a
  stale model name is a one-file change.

## License

MIT
