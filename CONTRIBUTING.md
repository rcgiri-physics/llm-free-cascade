# Contributing

Issues and PRs welcome.

## Fixing a stale model name

The most common reason to touch this repo: a provider retired or renamed its
free-tier model. This is a **one-file change**:

1. Confirm the replacement model actually works with a real request against
   the provider's API — free-tier availability shifts constantly, don't trust
   an unverified name from documentation alone.
2. Edit that provider's `defaultModel` in [`src/providers.json`](src/providers.json). Nothing else needs to change.
3. Update the table in [`README.md`](README.md) if the free-tier terms changed too.

## Adding a new free-tier provider

1. If it's OpenAI-compatible (`chat/completions` shape — most are), add an
   entry to [`src/providers.json`](src/providers.json) with `"apiStyle": "openai-compat"`,
   its `baseUrl`, `defaultModel`, `envVar`, and a `signupUrl`. That's it — no
   code changes, `callProviderWithKey` in [`src/index.js`](src/index.js) dispatches
   on `apiStyle` automatically.
2. Only add a bespoke caller (like `callGemini`/`callAnthropic`) if the
   provider's request/response shape genuinely isn't OpenAI-compatible.
3. Update the table in [`README.md`](README.md).

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
- **The last live provider is never put on cooldown.**
- **`signupUrl`s in `providers.json`** must be plain `https://host/path` — the
  CLI hands them to the OS shell to open a browser and refuses anything with a
  query string or shell metacharacters.

## Reporting a provider outage / model retirement

Open an issue naming the provider, the model, and the exact error response —
that's normally enough to fix in one PR.
