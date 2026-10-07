# Free-tier expansion & de-lagging plan

_Researched 2026-10-07 against `llm-free-cascade@0.8.1` (published on npm 2026-09-22)._

## Status (updated after implementation)

| Phase | State |
|---|---|
| P0 `providers.json` refresh | **Done.** Corrected Z.ai, Cerebras, Groq, Cohere, SambaNova, OpenRouter, Gemini, Mistral; added `tier`, `fallbackModels`, `limits`, `limitsSource`, flags, `verifiedAt`; reordered by tier. Added SiliconFlow, ModelScope, OVHcloud, LLM7. `npm run check:providers` validates models against live model lists (it already caught two stale defaults: Pollinations `openai` and LLM7 `gpt-4.1-nano`). |
| P1 Kill the lag | **Done** except hedging. Per-key round-robin and rest, per-model fallback, reset-aware cooldowns (Retry-After, error-text hints, minute/day windows, daily reset times), error classification, circuit breaker, `providerTimeoutMs`, opt-in `adaptiveOrder`. **Hedged parallel requests were deliberately not built**: they double-spend free quota. |
| P2 Custom providers | **Done.** `custom`, `baseUrls`, `LLM_CUSTOM_PROVIDERS`, `<PROVIDER>_BASE_URL`. |
| P3 Watching | **Done.** `stats()`, `onAttempt`, `probe()`, CLI `status` / `probe --watch`. |
| P4 OmniRoute | **Enabled, not recommended.** It works as a `custom` provider (see README). Not added as a default. |
| P5 Jev | **Harness ready, trial needs your API key.** `scripts/jev-compare.js cases.jsonl` runs your labelled classification cases through Jev (real request shape from docs.typesafe.ai: `POST api.typesafe.ai/v1/systemone`, `choice` question) and through the cascade, then reports agreement, accuracy vs your labels, latency and the disagreements. Tested end to end against mock servers only. Jev needs an account/key from console.typesafe.ai (early access, paid, free tier unknown). It stays out of this package. |
| P6 Release | **Prepared and verified, not published.** 0.9.0 + CHANGELOG, committed locally. `npm pack` is clean (7 files, 42.8 kB). mcqplex's AI tests (3 suites, 34 tests) pass against the 0.9.0 tarball swapped into its node_modules (restored to 0.8.0 afterwards). Blocked on `npm login` (npm whoami = 401): then `npm publish --access public`, bump mcqplex's pin, run its tests. `git push` not done. |

Two plan items changed on contact with reality:
- **GitHub Models is gone.** GitHub's docs say it was fully retired on 2026-07-30, so it was dropped from §2 and never added.
- **LLM7's "free" status is unverified.** Its live model list shows per-token prices and `turbo`/`pro` tiers; a tracker claimed a free 30 RPM token. It is included at tier 4, flagged `unverified`, with its three `turbo` models as defaults.

Things you still need to do yourself (no code can do them): create the accounts in §3, read each provider's terms before duplicating accounts, put the keys in your environment, then run `npx llm-free-cascade status` and `npx llm-free-cascade probe`.

## 0. How much to trust the numbers

| Confidence | Source | Covers |
|---|---|---|
| **High** (official docs read today) | OpenRouter limits page, Groq rate-limits page, Cerebras rate-limits page, Gemini rate-limits page, Z.ai pricing/quick-start, OpenRouter public `/api/v1/models` (queried live) | OpenRouter, Groq, Cerebras, Gemini (quota scope only), Z.ai |
| **Medium** | Aggregator trackers (gravity.fast "verified Oct 4 2026", yangmao.ai, freellm.net) | Cloudflare, Cohere, SambaNova, HF, NVIDIA, Mistral, SiliconFlow, ModelScope, OVH, etc. |
| **Low** | SEO blogs, one-source claims | Anything marked `?` below |

Free tiers change without notice (Cerebras, SambaNova and Chutes all lost their free tiers or were cut in 2026).
**Before you create accounts, open each provider's console and read its own limits page.** Numbers below are for sizing only.

---

## 1. What is lagging (found in the code, not guessed)

Ordered by how much latency/failed-quota each one costs you.

1. **Key rotation always starts at key #1.** `_callProvider` loops `keys[0..n]` on every call ([src/index.js:732](../src/index.js)). If key #1 is exhausted, *every* call pays one wasted round-trip (up to the 30 s timeout) before reaching key #2. Cooldown is per-provider, not per-key, so extra accounts make it slower, not faster.
2. **One model per provider.** Limits are almost always **per model**: Groq gives `gpt-oss-120b`, `gpt-oss-20b` and `qwen3.8-27b` each their own 30 RPM / 1,000 RPD / 200K TPD bucket. The cascade only ever uses one of them, so you leave 2/3 of a Groq account unused. Same for Gemini (per-model quotas) and Cerebras.
3. **OpenRouter's `:free` pool churns** (20 models live today; upstream providers 429 independently). With a single pinned model, one retired/limited model takes the whole provider offline for `cooldownMs`.
4. **A cooldown ignores the real reset window.** A 429 on a per-minute limit and on a per-day limit both cool for the same 10 min. Per-minute limits should be retried after ~60 s (so the chain wraps back to your fastest provider quickly); per-day limits shouldn't be retried until the reset (Gemini: midnight Pacific). `Retry-After` is never read.
5. **Any HTTP 4xx cools the provider, including request-specific ones.** A prompt too long for Cloudflare's 2–8K context returns 400 and benches Cloudflare for everyone for 10 min (README admits this). A model that rejects `response_format` does the same.
6. **Strictly sequential, fixed registry order.** Worst case is 15 providers × 30 s. The order is whatever `providers.json` lists (Gemini first), not fastest-first or best-for-task.
7. **`providers.json` is stale in places** (§4), e.g. Cerebras is now a $5/30-day trial, Z.ai's international endpoint is `api.z.ai` not `open.bigmodel.cn`, Groq's note says "~14400 requests/day" (it's now 1,000/model/day).
8. **No visibility.** You cannot answer "how many calls did Groq key #2 serve today, and when does it reset?" There is only `getLiveOrder()` and the failure hooks.

---

## 2. Provider map: gateways vs. standalone

### A. Gateways / routers (one signup → many upstream models)

| Name | What it is | Signup | Free capacity | Accounts to make |
|---|---|---|---|---|
| **OpenRouter** (already in) | Hosted router; `:free` model variants; `openrouter/free` auto-picks a free model | Email, no card | **20 RPM, 50 req/day**; 1,000/day once you have ever bought ≥ $10 credit. Docs: *"additional accounts or API keys will not affect your rate limits, as we govern capacity globally."* | **1.** More accounts are explicitly pointless. |
| **OmniRoute** ([diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)) | **Self-hosted** MIT gateway (`npm i -g omniroute`, port 20128). ~300 providers, "combos" (fallback chains), 19 routing strategies, circuit breakers, per-connection cooldown. 34K stars, pre-release. | None for the gateway; you bring each provider's key | Whatever your keys give. It also bundles "free" sources via OAuth reuse of subscription logins (Kiro, Qoder, Gemini CLI, iFlow) and unofficial keyless pools. | n/a (see §6) |
| **Kilo gateway** | Hosted; ~12 free models | Email? | ~200 req/hr (?) | 1 (optional) |
| **LLM7.io** | Free OpenAI-compatible gateway | none/email | 30 RPM (?) | 1 (optional, low tier) |
| **Requesty / OrcaRouter / AnyAPI** | Small routers | Email | 200 req/day · "4 free models" · 100K tok/day (?) | skip until the big ones are exhausted |
| **Vercel AI Gateway / Cloudflare AI Gateway / LiteLLM / Portkey** | Gateways over **your own** keys (no free models of their own) | n/a | none | **don't add**, they solve what this package already solves |
| **Hugging Face Inference Providers** (already in) | Router over several GPU hosts | Email | only **$0.10/month** credit now | 1, tail only |
| **Cloudflare Workers AI** (already in) | Hosted open models | Email | 10K neurons/day | 1–2 |

### B. Standalone model owners (sign up directly, free key)

| Provider | Free limits (see §0 for confidence) | Needs | Data / terms flags | Accounts |
|---|---|---|---|---|
| **Groq** ✅ high | per model: 30 RPM · 1,000 RPD · 8K TPM · 200K TPD (`gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b`). Limits are **per organization**. | Email | none noted | **2** |
| **Google AI Studio (Gemini)** ✅ scope / ⚠ numbers | Per **project**, not per key. Google no longer publishes a table (view in AI Studio → rate limit). Aggregators: ~15 RPM / ~1,000–1,500 RPD on Flash. RPD resets **midnight Pacific**. | Google account | Free-tier prompts may be used to improve Google products | **2** (Google account × project each; extra keys inside one project add nothing) |
| **Mistral La Plateforme** ⚠ conflicting | ~1 req/s, 500K tok/min, ~1B tokens/month (one tracker says a $10/month credit instead, check the console) | **Verified phone**, opt into data training | Free tier trains on your data | **1** (one phone) |
| **NVIDIA NIM** (`build.nvidia.com`) medium | ~40 RPM, no published daily cap, prototyping-only | NVIDIA account, phone usually | "trial / not for production" | **1** |
| **Z.ai (Zhipu GLM)** ✅ high on models | `GLM-4.7-Flash`, `GLM-4.5-Flash`, `GLM-4.6V-Flash` free, no expiry (concurrency-limited; one test measured ~26 s latency). Base URL `https://api.z.ai/api/paas/v4/`. | Email works internationally | China-hosted | **1** |
| ~~GitHub Models~~ | **Retired 2026-07-30** (GitHub's own docs). Trackers still list it. | n/a | n/a | **0** |
| **SiliconFlow** medium | up to 1,000 RPM / 50K TPM on its free open models (Qwen/GLM/DeepSeek-distill); intl. site gives ~$1 credit | `.cn` needs phone + real-name (mandatory since May 2026); `.com` email | China-hosted | **1** if signup works |
| **ModelScope** (Alibaba) medium | 2,000 RPD total, ≤ 500 per model; Qwen 3.5 family | Alibaba Cloud / phone; unclear for non-Chinese | China-hosted | **1** if signup works |
| **Alibaba Model Studio** (intl/Singapore) medium | ~1M tokens, expires in 90 days, auto-bills after | Card? | trial, not standing | skip |
| **Cloudflare Workers AI** | 10K neurons/day (~hundreds of small calls), 2–8K context | Email | n/a | 1–2 |
| **Cohere** medium | trial key: ~20 RPM, ~1,000 req/month | Email | **Non-commercial only**: don't point mcqplex.com at it | 1, research only |
| **Cerebras** ✅ high | now a **$5 trial credit, expires in 30 days**; `gpt-oss-120b`, `qwen-3.8-27b` at 5 RPM / 1M TPD; card reported required | Card (?) | n/a | 1 (burst tier while credit lasts) |
| **SambaNova** medium | trial/credit only, now wants a payment method | Card | n/a | 1 at most, tail |
| **OVHcloud AI Endpoints** low | 14 models, ~12 RPM anonymous, no registration | none | EU / GDPR | 0 (keyless tail) |
| **Scaleway** low | 1M tokens one-time | Card? | EU | skip |
| **Chutes** | **free tier ended** | n/a | n/a | drop |

### C. Keyless / community (use only as the very last free tier)
Pollinations (1 req/15 s anonymous), OpenCode Zen free models, OVH anonymous, OmniRoute's no-auth pools (mostly unreliable: in one test only 2 of the pools responded).

### D. Paid last resort
DeepSeek (≈ $0.27/M, cheapest sensible fallback), then Anthropic. Keep `maxTokensLimit` set.

---

## 3. How many accounts, and where it's worth it

**Honest limits of the "more accounts" lever**
- OpenRouter says outright that extra accounts don't help. Don't create them.
- Mistral/NVIDIA/SiliconFlow need a phone or real-name check, so each extra account costs a real phone.
- I did not read every provider's ToS. Many forbid creating multiple free accounts to dodge limits, and the penalty is usually a ban on *all* of them. **Check each provider's terms before duplicating accounts.** Gemini's per-*project* quota is the one place where a second key in a second project is clearly how the product is meant to be scaled.
- **Cheaper lever with zero ToS risk: per-model buckets (§1 item 2) and more distinct providers.** Do those first, then add the second account only where the table says **2**.

**Recommended account plan (≈ 15 accounts across 12 providers, including the two paid last-resort ones)**

| Priority | Provider | Accounts | Why |
|---|---|---|---|
| T1 fast, small | Groq | 2 | 3 models × 200K tokens/day = 600K tokens/day per org, so ≈ 1.2M tokens/day with 2 orgs. The 1,000 RPD is not the binding limit; **tokens are** (8K TPM also rules out big batch prompts) |
| T1 | Gemini | 2 (2 projects) | largest context, per-project quota |
| T1 | Cerebras | 1 | fastest while the $5 lasts; auto-drops when credit ends |
| T2 volume | Mistral | 1 | biggest token pool |
| T2 | NVIDIA NIM | 1 | 40 RPM, no daily cap |
| T2 | Z.ai | 1 | non-expiring free GLM |
| T3 gateways | OpenRouter | 1 | model-list fallback inside it (§5-P1) |
| T3 | Cloudflare | 1–2 | tail, small context |
| T3 | SiliconFlow / ModelScope | 1 each *if* signup works from Nepal | high RPM, China-hosted |
| T4 keyless | Pollinations, OVH, OpenCode Zen | 0 | tail |
| T5 paid | DeepSeek, then Anthropic | 1 each | only when everything above is cooled |

**"By the time it reaches the last point the first can be used again"** is a *timing* property, not an account count. It holds if (a) the cooldown for a provider equals its real reset window (§1 item 4), and (b) one full pass of the free tiers takes longer than the shortest reset. With per-minute resets of ~60 s on Groq/Mistral/NVIDIA, a 12-tier chain loops back to Groq long before your day is gone. The only genuinely daily-limited providers are Gemini, OpenRouter (50/day), Cloudflare, ModelScope. They can fall to the tail of the chain and be cooled until their reset.

Rough daily headroom with the table above, taking a request as ≈ 4K tokens in+out (my assumption, not measured from mcqplex):
- **Groq** is the fast tier but small: ~1.2M tokens/day across 2 orgs ≈ 300 calls, and its 8K tokens/minute cap means it can't take mcqplex's 8,192-token batch generations at all. Route only short calls there (`order` per call).
- **Mistral** (~1 req/s) and **NVIDIA** (~40 RPM, no published daily cap) are bound by requests per minute, not quota, so they carry the volume (thousands of calls/day each if the published numbers hold).
- **Gemini** adds roughly 1,000+ requests/day per project (unpublished, check AI Studio).
- Everything else is a few hundred calls/day of tail capacity.

That is enough for "any reasonable task", but only if long/batch calls are steered to Mistral, NVIDIA and Gemini and short ones to Groq. The binding constraints are **tokens per minute and per day on the fast tiers**, and burst RPM, which is why P1 (per-key/model state, reset-aware cooldowns, per-call `order`) matters more than extra accounts.

---

## 4. `providers.json` corrections (P0, no logic change)

| Entry | Now says | Should say / do |
|---|---|---|
| `zhipu` | `open.bigmodel.cn`, `glm-4-flash` | `https://api.z.ai/api/paas/v4`, default `glm-4.7-flash` (fallbacks `glm-4.5-flash`); signupUrl `https://z.ai` |
| `cerebras` | "free, very fast, rotates" | trial: `$5 credit / 30 days`, default `gpt-oss-120b` ok; add `trial: true` |
| `groq` | "~14400 requests/day" | `30 RPM, 1K RPD, 200K TPD per model`; add model list `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `openai/gpt-oss-20b` |
| `cohere` | "free trial key" | add `commercialOk: false` and warn in `keys` CLI |
| `mistral` | "~1 request/sec" | add `requiresPhone: true`, `trainsOnData: true` |
| `sambanova` | "free tier available" | now credit/payment-method gated |
| `openrouter` | one model | list + `openrouter/free`; note 50/day global |
| `gemini` | "~1500 requests/day" | "per project; see AI Studio; resets midnight PT" |
| all | no date | add `verifiedAt` and a `scripts/check-providers` that hits each provider's `/models` (keyless where possible, as I did for OpenRouter today) so retired default models are caught in CI instead of by users (commit `8ed1159` was exactly this fix) |

New entries to add (JSON only, all OpenAI-compatible): `github-models`, `siliconflow`, `modelscope`, `ovh`, `llm7`, `kilo`, `scaleway`. Check each base URL against its docs before adding.

---

## 5. Implementation plan

### P0: Truth refresh (½ day, no risk)
Edit `providers.json` per §4. Add `tier`, `limits`, `resetWindow` (`minute|hour|day` + timezone), `requiresPhone`, `commercialOk`, `trainsOnData`, `verifiedAt`. Teach `keys` CLI to print them.

### P1: Kill the lag (1–2 days)
1. **Per-key state.** Track `{cooldownUntil, calls, lastUsed}` per key. Start each call at the *least recently used healthy key* (round-robin) and skip keys on cooldown. Removes the wasted-round-trip in §1 item 1. Fits behind the existing `cooldownStore` (key it `provider#keyIndex`, never log key material).
2. **Per-provider model lists.** `models: { groq: [a, b, c] }` (still accepts a string). Cooldown at `provider:model` granularity, so a 429 on `gpt-oss-120b` falls to `qwen3.8-27b` on the same key *before* leaving Groq. Same for OpenRouter's `:free` list.
3. **Reset-aware cooldowns.** Parse `Retry-After`/`x-ratelimit-reset-*`; fall back to `resetWindow` from `providers.json` (minute→60 s, day→next midnight in its timezone). Keep `rateLimitCooldownMs` as the override.
4. **Error classification.** 400 context-length / unsupported-param → skip for this call only (no cooldown); 401/403 → key cooldown long; 429 → reset-aware; 5xx/timeout → short circuit-breaker. Replace the blanket `HTTP 4\d\d` rule in `isProviderLevelFailure`.
5. **Latency control.** Separate `connectMs` (≈ 8–10 s) from total `timeoutMs`; keep `deadlineMs` as the hard bound. Optional `hedge: true` that starts the next provider after *p*95 latency instead of waiting for the failure.
6. **Adaptive order** (opt-in): sort within a tier by EWMA latency × success rate, so slow days reorder themselves.
Tests: extend `test/cascade.test.js` with fake `fetch` for each of the above (the suite already works that way).

### P2: Custom/extra providers without code changes (1 day)
`new LLMCascade({ custom: { omniroute: { baseUrl, apiKey, model, tier } } })` plus env form `LLM_CUSTOM_PROVIDERS` JSON. That one feature covers OmniRoute, LiteLLM, Kilo, LLM7, Vercel/Requesty, anything OpenAI-compatible. Reuses `callOpenAICompat` unchanged.

### P3: Watching it (1 day). _I read "how to watch" as "how do I see what the cascade is doing". Tell me if you meant something else._
- `cascade.stats()` → per provider / model / key: calls, successes, 429s, timeouts, p50/p95 latency, tokens, cooldown remaining, **next reset ETA**.
- `onAttempt({provider, model, keyIndex, ok, ms, status})` hook so mcqplex can write it to its logger/DB.
- CLI: `npx llm-free-cascade status` (table) and `--watch` (refresh every 5 s), `probe` (one 1-token ping per configured key, to catch revoked keys *before* users do).
- Outside the code today: OpenRouter → *Activity* page; Groq → console *Usage*; Gemini → AI Studio → *Rate limit*; the existing `attempts` field and `getLiveOrder()` for in-process checks.

### P4: OmniRoute: optional, last (decide after P2)
See §6.

### P5: Jev: separate experiment (see §7)

### P6: Release
Bump to 0.9.0, update README table + this file, `npm publish`, then bump mcqplex's pin (currently `0.8.0`) after its own tests.

---

## 6. OmniRoute: use it or not?

**What it gives:** a ready-made dashboard, 19 routing strategies, circuit breakers and a huge provider catalog, behind one OpenAI-compatible URL (`http://localhost:20128/v1`).

**Why I wouldn't make it a dependency:**
- It re-implements what this package already does; putting both in series means two cooldown systems arguing about the same provider.
- It needs a long-running server (~540 MB RAM idle) next to mcqplex; this package is zero-dependency and serverless-friendly.
- Its default dashboard password is the literal `CHANGEME`, and it holds **every** key you configure, so one exposed port leaks all providers.
- Several of its "free" sources are OAuth reuse of consumer subscriptions or unofficial keyless pools. That's the ToS-grey area and the unreliable one.
- Pre-release (v3.8.x, hundreds of open issues).

**Where it is useful:** as an experiment to *discover* which obscure free providers currently work, and (via P2) as one optional late tier, `custom.omniroute`, with its `auto/best-free` combo, if you want a safety net. Mine it for ideas (auto-scoring, circuit breakers), not code.

---

## 7. "Dev J-E-V AI": Jev (TypeSafe AI)

I'm reading this as **Jev** by TypeSafe AI ([typesafe.ai](https://typesafe.ai), docs at `docs.typesafe.ai`, console `console.typesafe.ai`). **Confirm that's what you meant.**

- It is a "System One" model: it does **not generate text**. You give it state plus a typed question (Choice / Score / yes-no probability) and it returns a decision with a confidence in ~70–500 ms. Early access; stated price $42 per billion input tokens (≈ $0.04/M). I found no confirmed free tier.
- So it is **not a cascade provider** and does not belong in `providers.json`.
- **Where it fits:** mcqplex's `ai.service.js` has 7 deterministic call sites already flagged `noThinking` (`classifyCdcLevelAI`, `screenQuestionAI`, `verifyAnswerAI`, …). Those are classification/verification, exactly Jev's job. Moving them off the free LLM quota would save requests for the tasks that need real generation. Also usable as the `parse`-validation step ("is this MCQ well-formed? 0–1").
- **Plan:** request access, run those 7 prompts through both, compare agreement on ~200 saved cases, adopt only if agreement is high and latency/cost win. Keep it in mcqplex, not in this zero-dep package.

---

## 8. Is this a "research project"?

What I can verify:
- The package is **engineering, not research**: published to npm (0.8.1), 1 GitHub star, 0 forks, one real consumer. `mcqplex` already pins `llm-free-cascade@0.8.0` and its `ai.service.js` requires it. (My earlier note that the migration hadn't started is out of date.)
- It's also referenced in `business_research/` plans (drafting Nepali CS content) and the `rcgiri-physics` profile README.
- The niche is crowded: OmniRoute (34K★), FreeLLMAPI (28 providers), a Python `free-apis-llm-cascade`, a Rust `llm-cascade`. This package's differentiator is **zero-dependency, in-process Node library** (no proxy server to host).
- **As a research tool** it is a good fit for batch jobs that tolerate a mixed bag of models (labeling, summarising papers, drafting). Two cautions: results differ by which provider answered, so log `provider` + model with each result (already returned); and free-tier terms (Gemini/Mistral train on free-tier data; Cohere is non-commercial) matter for unpublished data.
- Honest limit: I couldn't find evidence of academic use, and an npm download count wasn't available to me.

---

## 9. Decisions needed from you

1. Confirm **Jev = TypeSafe AI**.
2. OK to start **P0 + P1** (providers.json refresh and the lag fixes)? They're the highest-value, lowest-risk part.
3. Comfort level with **second accounts** where §3 says 2 (Groq, Gemini). Zero extra accounts still works; you'd just have ~half the Groq/Gemini headroom.
4. Is "how to watch" = monitoring (P3)? If you meant something else (e.g., watching the repo/competitors), say so.

## Sources
- OpenRouter limits: https://openrouter.ai/docs/api-reference/limits · free list API: https://openrouter.ai/api/v1/models
- Groq: https://console.groq.com/docs/rate-limits · Cerebras: https://inference-docs.cerebras.ai/support/rate-limits · Gemini: https://ai.google.dev/gemini-api/docs/rate-limits · Z.ai: https://docs.z.ai/guides/overview/pricing, https://docs.z.ai/guides/overview/quick-start
- Trackers (medium confidence): https://gravity.fast/data/free-llm-api-tiers/ · https://openrouter.ai/blog/tutorials/free-llm-apis-compared/ · https://github.com/12britz/awesome-free-models · https://freellm.net/blog/china-free-llm-ecosystem · https://china-llm.com/blog/chinese-llm-api-free-tiers
- OmniRoute: https://github.com/diegosouzapw/OmniRoute · https://pinggy.io/blog/omniroute_ai_gateway_security/
- Jev: https://typesafe.ai · https://www.everydev.ai/tools/jev
