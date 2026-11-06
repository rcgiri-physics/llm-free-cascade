'use strict';

// What a failed attempt means: the error type, classification, reset times and
// the limits they are clamped to.

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_TOKENS = 1024;
// No cooldown (or Retry-After) is ever longer than a day, and none shorter than a second.
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_COOLDOWN_MS = 1000;
// "Rolling" daily limits have no clock-time reset we can compute, so a
// day-exhausted slot is re-checked about once an hour.
const ROLLING_DAY_RECHECK_MS = 60 * 60 * 1000;

class LLMCascadeError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=502]
   * @param {string|null} [code=null]
   * @param {{provider: string, message: string}[]} [failures=[]] - per-provider
   *   redacted failure messages. Log these; don't forward them to end users.
   */
  constructor(message, statusCode = 502, code = null, failures = []) {
    super(message);
    this.name = 'LLMCascadeError';
    this.statusCode = statusCode;
    this.code = code;
    this.failures = failures;
  }
}

const CONTEXT_RE = /context.{0,30}(length|window)|maximum.{0,20}(context|length)|too (long|large)|reduce the (length|size)|token limit|exceeds? the (model|maximum|max)|prompt is too/i;

/**
 * What a failure means for the NEXT attempt, decided from its message:
 *  - `request`: this particular prompt is the problem (context too long, 413).
 *    Another key or model of the same provider won't help and the provider
 *    itself is fine, so it is skipped for this call only, with no cooldown.
 *  - `rate`: 429 / quota. Only that key+model "slot" is spent — try the next
 *    key, then the next model.
 *  - `auth`: 401/403 / bad key. That key is dead — try the next key.
 *  - `model`: the model is gone or unsupported (404 etc.) — try the next model.
 *  - `fatal`: anything else; stop retrying this provider.
 */
function classifyFailure(message = '') {
  const status = Number(/^\S* ?HTTP (\d{3})\b/.exec(message)?.[1]) || null;
  const rateText = /quota|rate.?limit|too many requests|exhaust/i;
  const authText = /invalid.{0,12}key|api key|unauthori[sz]ed|forbidden/i;
  const modelText = /model.{0,40}(not found|does not exist|decommission|deprecat|no longer|not supported|unavailable)|(unknown|invalid|unsupported).{0,20}model/i;

  if (status) {
    // The status decides; the text only refines it. Error text can contain
    // anything ("429 tokens processed" on a 500), so it never overrides a 5xx.
    if (status >= 500) return 'fatal';
    if (status === 429) return 'rate';
    if (status === 402) return 'auth'; // this account is out of credit; another key may not be
    if (status === 404) return 'model';
    if (status === 401 || status === 403) return rateText.test(message) ? 'rate' : 'auth';
    if ((status === 400 || status === 413 || status === 422) && CONTEXT_RE.test(message)) return 'request';
    if (rateText.test(message)) return 'rate';
    if (authText.test(message)) return 'auth'; // Gemini reports a bad key as a 400
    if (modelText.test(message)) return 'model';
    return 'request'; // any other 4xx is about this request, not the provider's health
  }
  if (/network error|timed out|unparseable/i.test(message)) return 'fatal';
  if (/\b429\b/.test(message) || rateText.test(message)) return 'rate';
  if (/\b(401|403)\b/.test(message) || authText.test(message)) return 'auth';
  if (modelText.test(message)) return 'model';
  return 'fatal';
}

/** Timeouts, dropped connections and 5xx: likely to clear on their own, but costly to retry on every call. */
function isTransientFailure(message = '') {
  return /timed out|network error|\bHTTP 5\d\d\b|unparseable/i.test(message);
}

/**
 * Parses "33.1s", "2m59.52s", "250ms", "1h2m" (what Gemini and Groq put in
 * their 429 text/headers) — or a bare number of seconds (a Retry-After
 * header) — into milliseconds. `undefined` when it isn't a duration.
 */
function parseDurationMs(value) {
  if (value == null) return undefined;
  const s = String(value).trim().slice(0, 64);
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const units = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(m[1]) * units[m[2]];
  }
  return matched ? total : undefined;
}

/** `ms` as a usable cooldown (finite, within [1s, 24h]), or `undefined` if it isn't one. */
function clampCooldown(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(ms, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS) : undefined;
}

function headerValue(headers, name) {
  try {
    return headers && typeof headers.get === 'function' ? headers.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Retry-After (seconds or an HTTP date) in ms, or `undefined`. Tolerates test doubles with no `headers`. */
function retryAfterFromHeaders(headers) {
  const raw = headerValue(headers, 'retry-after');
  if (!raw) return undefined;
  const asDuration = parseDurationMs(raw);
  if (asDuration != null) return clampCooldown(asDuration);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? clampCooldown(when - Date.now()) : undefined;
}

/** A "please retry in 33.1s" / "try again in 2m59.5s" hint inside a provider's own error text. */
function retryHintFromMessage(message = '') {
  const m = /(?:retry|try again)(?: again)? in ([0-9.]+(?:ms|h|m|s)(?:[0-9.]+(?:ms|h|m|s))*)/i.exec(message)
    || /retry after (\d+)\s?(?:seconds|secs|s)\b/i.exec(message);
  return m ? clampCooldown(parseDurationMs(m[1] + (/^\d+$/.test(m[1]) ? 's' : ''))) : undefined;
}

/** Which window a rate-limit message is about, when it says: `'day'`, `'minute'`, or `null`. */
function rateWindow(message = '') {
  if (/per[ -]?day|\bdaily\b|\bRPD\b|\bTPD\b|PerDay/i.test(message)) return 'day';
  if (/per[ -]?minute|\bRPM\b|\bTPM\b|PerMinute/i.test(message)) return 'minute';
  return null;
}

/** ms until the next local midnight in an IANA `timeZone` (+1s of slack). One hour if the zone is unusable. */
function msUntilMidnight(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
    if (!Number.isFinite(elapsed)) throw new Error('bad time');
    return (86400 - elapsed) * 1000 + 1000;
  } catch {
    return ROLLING_DAY_RECHECK_MS;
  }
}

/** Attaches the server's Retry-After (429/503 only) to an error so the cascade can cool the slot for exactly that long. */
function withRetry(err, res) {
  if (res && (res.status === 429 || res.status === 503)) {
    const ms = retryAfterFromHeaders(res.headers);
    if (ms) err.retryAfterMs = ms;
  }
  return err;
}

/** Re-throws `err` with a provider prefix while keeping the structured fields the cascade reads. */
function prefixError(prefix, err) {
  const out = new Error(`${prefix} ${err.message}`);
  if (err.retryAfterMs) out.retryAfterMs = err.retryAfterMs;
  if (err.requestSpecific) out.requestSpecific = true;
  return out;
}

/**
 * A base URL we're willing to send a bearer token to: https, or plain http
 * only for localhost (a self-hosted gateway). No embedded credentials.
 */
function validateBaseUrl(raw, label) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`${label}: baseUrl must be a valid URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`${label}: baseUrl must be https:// (http:// is allowed only for localhost)`);
  }
  if (u.username || u.password) throw new Error(`${label}: baseUrl must not embed credentials`);
  return u.href.replace(/\/+$/, '');
}

/** Structural faults that will recur for the whole run — worth a cooldown. */
function isProviderLevelFailure(message = '') {
  return /MAX_TOKENS|no content|HTTP 4\d\d|unknown provider|no API key/i.test(message);
}

/** A rate-limit / quota failure — cooled down for `rateLimitCooldownMs` rather than the structural `cooldownMs`. */
function isRateLimitFailure(message = '') {
  return /\b429\b|quota|rate.?limit/i.test(message);
}

/** A usable timeout in ms: finite and positive, otherwise the default. `0`/negative/NaN are treated as "not set", not "no timeout". */
function resolveTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

/** A usable max_tokens: a positive integer, optionally clamped to `limit`, otherwise the default. */
function resolveMaxTokens(maxTokens, limit) {
  let n = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS;
  if (Number.isFinite(limit) && limit > 0) n = Math.min(n, Math.floor(limit));
  return n;
}

/** A promise that rejects with an AbortError when `signal` fires (never resolves). */
function abortRejection(signal) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function timeoutMessage(err, ms) {
  return err && err.name === 'AbortError' ? `timed out after ${ms}ms` : err.message;
}

module.exports = {
  ROLLING_DAY_RECHECK_MS,
  LLMCascadeError,
  CONTEXT_RE,
  classifyFailure,
  isTransientFailure,
  parseDurationMs,
  clampCooldown,
  retryHintFromMessage,
  rateWindow,
  msUntilMidnight,
  withRetry,
  prefixError,
  validateBaseUrl,
  isProviderLevelFailure,
  isRateLimitFailure,
  resolveTimeout,
  resolveMaxTokens,
  abortRejection,
  timeoutMessage,
};
