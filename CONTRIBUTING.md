# Contributing

Issues and PRs welcome.

## Fixing a stale model name

The most common reason to touch this repo: a provider retired or renamed its
free-tier model. This is a **one-file change**:

1. Confirm the replacement model actually works with a real request against
   the provider's API — free-tier availability shifts constantly, don't trust
   an unverified name from documentation alone.
2. Edit that provider's `defaultModel` in [`src/providers.json`](src/providers.json). Nothing else needs to change.
3. Run `npm run build:site` to regenerate the provider table on the project page (`docs/index.html`), and update the table in [`docs/GUIDE.md`](docs/GUIDE.md) if the free-tier terms changed too.

Run `npm run check:providers` to see which default/fallback models the
provider's own model list no longer has (it needs the provider's key in your
environment, except for the few that list models publicly).

## Adding a new free-tier provider

1. If it's OpenAI-compatible (`chat/completions` shape — most are), add an
   entry to [`src/providers.json`](src/providers.json) with `"apiStyle": "openai-compat"`,
   its `baseUrl`, `defaultModel`, `fallbackModels` (other models on the same
   key, ideally with their own rate-limit bucket; `[]` if unknown), `tier`
   (1 fast and roomy … 5 paid; **keep the file sorted by tier**, the default
   order is the file order), `envVar`, a `signupUrl`, and `freeTierNotes`. That's
   it — no code changes, `callProviderWithKey` in [`src/index.js`](src/index.js)
   dispatches on `apiStyle` automatically.
2. Record what you know about the limits, honestly: `limits` (`rpm`, `rpd`,
   `tpm`, `tpd`, `perModel`, `scope`), `limitsSource` (`official` only if you read
   the provider's own docs, otherwise `tracker` or `unverified`), `verifiedAt`,
   and the flags that matter to a user before signing up: `trial`,
   `requiresPhone`, `requiresCard`, `commercialOk: false`, `trainsOnData`,
   `region`. If a daily limit resets at a clock time, add `dayReset`
   (`"midnight:America/Los_Angeles"`).
3. Don't add a provider whose free tier you couldn't confirm exists. Prefer
   `limitsSource: "unverified"` plus an honest note over a confident guess.
4. Only add a bespoke caller (like `callGemini`/`callAnthropic`) if the
   provider's request/response shape genuinely isn't OpenAI-compatible.
5. Run `npm run build:site` and update the table in [`docs/GUIDE.md`](docs/GUIDE.md).

## Running tests

```bash
npm test
```

The test suite doesn't make real network calls — `fetch` is stubbed, and the
tests exercise config/parsing logic (provider ordering, key rotation,
`parseJsonLoose`), timeouts, streaming, redaction, and cooldowns. If you want
to sanity-check a live provider, use `examples/basic.js` with a real key.

A few things the tests guard that are easy to regress:

- **Regexes that touch provider output must be linear.** `redact()` and
  `stripFences()` use bounded whitespace classes on capped input; two
  adjacent unbounded `\s*` on a long run of spaces is a quadratic-backtracking
  DoS (it was 150 s on 200 KB before the fix).
- **Timeouts cover the body, not just the headers**, and for streams they're
  per-chunk (idle), not per-stream.
- **The last live provider is never put on cooldown**, and when every key+model
  of a provider is resting, the one that recovers soonest is still tried.
- **Key material never leaves the instance.** `stats()`, `onAttempt` and
  `probe()` report keys by index only, and their error text is redacted.
- **A request-specific failure (prompt too long) must not cool a provider**:
  it would bench it for every other caller.
- **Anything that makes a request to a user-supplied URL** (`custom`,
  `baseUrls`) goes through `validateBaseUrl`: https only, http only for localhost.
- **`providers.json` stays sorted by `tier`.** It is the default order.
- **`signupUrl`s in `providers.json`** must be plain `https://host/path` — the
  CLI hands them to the OS shell to open a browser and refuses anything with a
  query string or shell metacharacters.

## Reporting a provider outage / model retirement

Open an issue naming the provider, the model, and the exact error response —
that's normally enough to fix in one PR.
