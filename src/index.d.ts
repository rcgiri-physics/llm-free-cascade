export type BuiltinProvider =
  | 'groq' | 'gemini' | 'cerebras' | 'mistral' | 'nvidia' | 'zhipu'
  | 'openrouter' | 'siliconflow' | 'modelscope' | 'cloudflare' | 'huggingface' | 'cohere'
  | 'together' | 'sambanova' | 'pollinations' | 'opencode' | 'ovh' | 'llm7'
  | 'deepseek' | 'anthropic';

/** A built-in provider, or the name of a `custom` provider you registered. */
export type Provider = BuiltinProvider | (string & {});

export interface CustomProvider {
  /** https://... (or http://localhost... for a self-hosted gateway). Requests go to `<baseUrl>/chat/completions`. */
  baseUrl: string;
  /** Model to use. Give `models` instead for an ordered fallback list. */
  model?: string;
  models?: string[];
  apiKey?: string;
  apiKeys?: string[];
  /** 1 (fast and roomy) to 5 (paid last resort). Places it in the default order. Default 3. */
  tier?: number;
  /** Extra request headers (Authorization / Content-Type / Host are not allowed). */
  headers?: Record<string, string>;
  /** When a daily limit resets, e.g. `"midnight:America/Los_Angeles"`. Default: re-check hourly. */
  dayReset?: string;
}

export interface AttemptInfo {
  provider: Provider;
  model: string;
  /** Position in the provider's key list. The key itself is never exposed. */
  keyIndex: number;
  ok: boolean;
  ms: number;
  /** On failure: what kind of failure it was. */
  kind?: 'rate' | 'auth' | 'model' | 'request' | 'fatal';
  /** Redacted. */
  error?: string;
  at: number;
}

export interface UsageCounters { calls: number; ok: number; rateLimited: number; }

export interface ProviderStats {
  tier: number;
  keyCount: number;
  calls: number;
  ok: number;
  failures: number;
  rateLimited: number;
  timeouts: number;
  latencyMs: { ewma: number | null; p50: number | null; p95: number | null };
  tokens: { prompt: number; completion: number; total: number };
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  /** Remaining provider-level cooldown (0 when live). */
  providerCooldownMs: number;
  /** How long until some key+model of this provider is usable and the provider is out of cooldown (0 = usable now). */
  usableInMs: number;
  keys: (UsageCounters & { index: number; cooldownMs: number })[];
  models: Record<string, UsageCounters & { cooldownMs: number }>;
}

export interface CascadeStats {
  since: number;
  uptimeMs: number;
  providers: Record<string, ProviderStats>;
}

export interface ProbeResult {
  provider: Provider;
  keyIndex: number;
  model: string;
  ok: boolean;
  ms: number;
  status: number | null;
  /** Redacted. */
  message: string | null;
}

export interface LLMCascadeOptions {
  keys?: Partial<Record<Provider, string | string[]>>;
  /** Provider order. Default: every provider with a key, in tier order (see providers.json). */
  order?: Provider[];
  /** A string pins exactly that model; an array is an ordered list tried in turn (a 429 on the first falls to the second on the same key). Without an entry, providers.json's `defaultModel` then `fallbackModels` are used. */
  models?: Partial<Record<Provider, string | string[]>>;
  /** Extra OpenAI-compatible providers: a self-hosted gateway (OmniRoute, LiteLLM), a community router, anything not in providers.json. */
  custom?: Record<string, CustomProvider>;
  /** Re-point a built-in provider at another base URL (e.g. the China Zhipu endpoint, or your own proxy). */
  baseUrls?: Partial<Record<BuiltinProvider, string>>;
  cloudflareAccountId?: string;
  /** How long a provider sits out after a structural failure (bad key, retired model, no content). */
  cooldownMs?: number;
  /** Pins the cooldown after a rate-limit/quota (429). When NOT set it is reset-aware: Retry-After, else a hint in the error text, else a minute for a per-minute limit, else until the provider's daily reset, else `cooldownMs`. */
  rateLimitCooldownMs?: number;
  /** Circuit breaker: after 2 consecutive timeouts/network errors/5xx, skip the provider this long (default 60000; 0 disables). */
  breakerMs?: number;
  /** Per-provider default timeout, e.g. `{ groq: 10000 }`. A `timeoutMs` passed to generate() still wins. */
  providerTimeoutMs?: Partial<Record<Provider, number>>;
  /** Within each run of same-tier providers, reorder by observed latency and success rate once there are enough samples. Off by default. */
  adaptiveOrder?: boolean;
  /** Total time budget for one generate() call across every provider tried. Exceeding it throws `DEADLINE_EXCEEDED`. */
  deadlineMs?: number;
  /** Hard ceiling applied to every call's `maxTokens`, for cost control when it comes from an untrusted request. */
  maxTokensLimit?: number;
  appName?: string;
  referer?: string;
  /** Per-attempt timeout covering connect + headers + body. For streams: time-to-first-byte, then an idle timeout re-armed per chunk. */
  timeoutMs?: number;
  modelResolver?: (provider: Provider) => string | null | undefined;
  onProviderFailure?: (provider: Provider, message: string) => void;
  onProviderCooldown?: (provider: Provider, cooldownMs: number) => void;
  /** Called after every single HTTP attempt (each key x model tried). Key material is never included. */
  onAttempt?: (attempt: AttemptInfo) => void;
  /** Where PROVIDER-level cooldowns live (share it across processes with Redis etc.). Per-key and per-model cooldowns are always in-process. */
  cooldownStore?: {
    get(provider: Provider): number | Promise<number>;
    set(provider: Provider, until: number): void | Promise<void>;
    /** Optional: answer for the whole chain in one round-trip (e.g. Redis MGET). */
    getMany?(providers: Provider[]): number[] | Promise<number[]>;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateParams {
  system: string;
  /** Single-turn user message. Ignored if `messages` is given; one of the two is required. */
  user?: string;
  /** Full conversation history, for multi-turn calls. Takes precedence over `user` when both are given. Validated strictly (roles `user`/`assistant` only, non-empty string content, first turn `user`); a bad history rejects with `INVALID_INPUT` before any provider is called. */
  messages?: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  /** Gemini only: disables "thinking" (`thinkingBudget: 0`) for deterministic/structured calls. Ignored by every other provider. */
  noThinking?: boolean;
  parse?: (text: string) => any;
  timeoutMs?: number;
  /** Override the provider chain for just this call (providers without a configured key are dropped; falls back to the instance's default order if empty/omitted). */
  order?: Provider[];
  stream?: boolean;
}

export interface Usage {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  totalTokens: number | undefined;
}

export interface ProviderFailure {
  provider: Provider;
  /** Redacted. Safe to log; not meant to be forwarded to end users. */
  message: string;
}

export interface GenerateResult<T = any> {
  text: string;
  parsed: T | undefined;
  provider: Provider;
  usage: Usage | undefined;
  /** Estimated cost in USD had this call gone to a paid tier, based on `providers.json`'s `costPerMillionTokens`. `undefined` when usage or a known price isn't available. Informational only — not a real charge. */
  shadowCostUsd: number | undefined;
  /** Every provider tried and skipped before the one that succeeded, in order. Empty when the first provider tried succeeded. */
  attempts: ProviderFailure[];
}

export interface StreamResult {
  stream: AsyncIterable<string>;
  provider: Provider;
  attempts: ProviderFailure[];
}

export class LLMCascadeError extends Error {
  statusCode: number;
  code: 'ALL_RATE_LIMITED' | 'ALL_PROVIDERS_FAILED' | 'DEADLINE_EXCEEDED' | 'INVALID_INPUT' | null;
  /** One entry per provider attempted, in order. */
  failures: ProviderFailure[];
}

export class LLMCascade {
  constructor(options?: LLMCascadeOptions);
  static fromEnv(options?: LLMCascadeOptions): LLMCascade;
  generate(params: GenerateParams & { stream: true }): Promise<StreamResult>;
  generate<T = any>(params: GenerateParams): Promise<GenerateResult<T>>;
  getLiveOrder(): Promise<Provider[]>;
  /** Manually clear a provider's cooldown early (and its per-key and per-model cooldowns), e.g. after your own health check confirms it's back. No-op if it wasn't cooling. */
  clearCooldown(provider: Provider): Promise<void>;
  /** What the cascade has done since this instance was created (in-process): per provider/model/key counters, latency, tokens, cooldowns. Keys appear by index only. */
  stats(): Promise<CascadeStats>;
  /** Sends one tiny request through every configured key (default: whole chain), one at a time. Spends a little real quota; never changes cooldowns. */
  probe(options?: { providers?: Provider[]; timeoutMs?: number; maxTokens?: number }): Promise<ProbeResult[]>;
}

export function parseJsonLoose(text: string): any;
/** Scrubs credential-looking tokens from a message. Pass `secrets` (literal key values) for deterministic redaction regardless of phrasing. */
export function redact(message: string, secrets?: string[]): string;
export const ALL_PROVIDERS: Provider[];
export const DEFAULT_MODELS: Record<BuiltinProvider, string>;

export interface ProviderInfo {
  envVar: string;
  apiStyle: string;
  baseUrl: string | null;
  defaultModel: string;
  /** Tried after `defaultModel` on the same key(s) when it is rate-limited or retired. */
  fallbackModels: string[];
  /** 1 fast and roomy ... 5 paid last resort. providers.json is sorted by this, and it is the default order. */
  tier: number;
  signupUrl: string;
  freeTierNotes: string;
  /** Machine-readable free-tier limits where known. `scope` is what the limit is counted against. */
  limits?: { rpm?: number; rps?: number; rpd?: number; tpm?: number; tpd?: number; perModel?: boolean; scope?: string };
  /** Where the numbers came from: the provider's own docs, a third-party tracker, or not verified. */
  limitsSource?: 'official' | 'tracker' | 'unverified';
  /** e.g. `"midnight:America/Los_Angeles"`; absent means a rolling window. */
  dayReset?: string;
  /** A trial or credit, not a standing free tier. */
  trial?: boolean;
  requiresPhone?: boolean;
  requiresCard?: boolean;
  /** `false` = the free tier forbids commercial use. */
  commercialOk?: boolean;
  trainsOnData?: boolean;
  region?: string;
  verifiedAt?: string;
  extraHeaders?: boolean;
  /** Approximate list price per 1M tokens (blended prompt+completion) if this provider's model were used on a paid tier, at time of writing. Used to compute `shadowCostUsd`. Omitted where no meaningful paid comparison exists. */
  costPerMillionTokens?: number;
}

export const PROVIDER_INFO: Record<BuiltinProvider, ProviderInfo>;
