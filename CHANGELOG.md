# Changelog

## 0.9.0

Fixes what made the cascade slow when it had several keys and models, and
refreshes the provider list against what free tiers look like in October 2026.
Backward compatible for callers that pass `order` and pin `models` as strings
(as mcqplex does); see "Behaviour changes" for the rest.

### Added
- **Per-key and per-model rotation.** Keys are used round-robin; a rate-limited
  or rejected key rests and is skipped without a request, instead of being
  retried first on every call.
- **Model fallbacks inside a provider.** `fallbackModels` in `providers.json`
  and `models: { groq: [a, b] }`; a 429 on one model falls to the next on the
  same key before leaving the provider (most free tiers limit per model).
- **Reset-aware cooldowns** from `Retry-After`, "try again in 2m59s" hints in
  the error text, per-minute vs per-day wording, and each provider's daily
  reset time (`dayReset`).
- **Error classification.** A prompt that is too long for one provider no longer
  cools that provider for everyone; a retired model (404) is dropped for all
  keys; a 401/403 takes only that key out.
- **Circuit breaker** (`breakerMs`) for repeated timeouts / network errors / 5xx.
- `providerTimeoutMs`, `adaptiveOrder`.
- **`custom` providers** and **`baseUrls`** overrides (plus `LLM_CUSTOM_PROVIDERS`
  and `<PROVIDER>_BASE_URL` in `fromEnv()`), so a gateway like OmniRoute or
  LiteLLM, or any OpenAI-compatible endpoint, needs no code change.
- **Observability:** `stats()`, `onAttempt`, `probe()`; CLI `status` and
  `probe [--watch N] [--json]`; `npm run check:providers`.
- New providers: SiliconFlow, ModelScope, OVHcloud AI Endpoints, LLM7 (LLM7's
  free tier is marked unverified).
- `providers.json` gains `fallbackModels`, `tier`, `limits`, `limitsSource`,
  `verifiedAt`, `dayReset` and user-facing flags (`trial`, `requiresPhone`,
  `requiresCard`, `commercialOk`, `trainsOnData`, `region`). The `keys` CLI shows them.

### Behaviour changes
- **Default order is now by tier** (Groq, Gemini, Cerebras first; paid last)
  instead of Gemini first. Pass `order` (or `LLM_PROVIDER_ORDER`) to keep your own.
- **Default models are tried with their fallbacks** unless you pin a model
  (string) or use a `modelResolver`.
- **429 cooldowns are shorter and more exact** unless you set
  `rateLimitCooldownMs`, which pins them as before.
- Groq's default model is now `openai/gpt-oss-120b`; Zhipu now points at the
  international `api.z.ai` (default `glm-4.7-flash`). A key from
  `open.bigmodel.cn` needs `baseUrls: { zhipu: 'https://open.bigmodel.cn/api/paas/v4' }`.
- Pollinations' default model is `openai-fast` (the old `openai` is gone).
- Metadata corrections: Cerebras is a 30-day $5 trial, SambaNova needs a payment
  method, Cohere's trial key is non-commercial, OpenRouter's 50 requests/day is
  global per user.
- A provider on cooldown from a 429 now recovers when its keys/models do, not
  after the full `cooldownMs`.

### Not done, on purpose
- **Hedged (parallel) requests.** They double-spend free quota for a latency
  win; `providerTimeoutMs` and the circuit breaker address the cost of a slow or
  dead provider without it.
- **GitHub Models** was planned and dropped: it was retired on 2026-07-30.
