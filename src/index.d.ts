export type Provider =
  | 'gemini' | 'groq' | 'cerebras' | 'sambanova' | 'mistral'
  | 'openrouter' | 'together' | 'deepseek' | 'cohere' | 'huggingface'
  | 'cloudflare' | 'zhipu' | 'nvidia' | 'opencode' | 'pollinations' | 'anthropic';

export interface LLMCascadeOptions {
  keys?: Partial<Record<Provider, string | string[]>>;
  order?: Provider[];
  models?: Partial<Record<Provider, string>>;
  cloudflareAccountId?: string;
  cooldownMs?: number;
  /** Cooldown after a rate-limit/quota (429) failure on a provider's last key. Defaults to `cooldownMs`. */
  rateLimitCooldownMs?: number;
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
  /** Manually clear a provider's cooldown early — e.g. after your own out-of-band health check confirms it's back online. No-op if it wasn't on cooldown. */
  clearCooldown(provider: Provider): Promise<void>;
}

export function parseJsonLoose(text: string): any;
/** Scrubs credential-looking tokens from a message. Pass `secrets` (literal key values) for deterministic redaction regardless of phrasing. */
export function redact(message: string, secrets?: string[]): string;
export const ALL_PROVIDERS: Provider[];
export const DEFAULT_MODELS: Record<Provider, string>;

export interface ProviderInfo {
  envVar: string;
  apiStyle: string;
  baseUrl: string | null;
  defaultModel: string;
  signupUrl: string;
  freeTierNotes: string;
  extraHeaders?: boolean;
  /** Approximate list price per 1M tokens (blended prompt+completion) if this provider's model were used on a paid tier, at time of writing. Used to compute `shadowCostUsd`. Omitted where no meaningful paid comparison exists. */
  costPerMillionTokens?: number;
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo>;
