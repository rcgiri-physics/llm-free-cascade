export type Provider =
  | 'gemini' | 'groq' | 'cerebras' | 'sambanova' | 'mistral'
  | 'openrouter' | 'together' | 'deepseek' | 'cohere' | 'huggingface'
  | 'cloudflare' | 'zhipu' | 'nvidia' | 'opencode' | 'anthropic';

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

export interface GenerateParams {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  parse?: (text: string) => any;
  timeoutMs?: number;
  stream?: boolean;
}

export interface Usage {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  totalTokens: number | undefined;
}

export interface GenerateResult<T = any> {
  text: string;
  parsed: T | undefined;
  provider: Provider;
  usage: Usage | undefined;
}

export interface StreamResult {
  stream: AsyncIterable<string>;
  provider: Provider;
}

export interface ProviderFailure {
  provider: Provider;
  /** Redacted. Safe to log; not meant to be forwarded to end users. */
  message: string;
}

export class LLMCascadeError extends Error {
  statusCode: number;
  code: 'ALL_RATE_LIMITED' | 'ALL_PROVIDERS_FAILED' | 'DEADLINE_EXCEEDED' | null;
  /** One entry per provider attempted, in order. */
  failures: ProviderFailure[];
}

export class LLMCascade {
  constructor(options?: LLMCascadeOptions);
  static fromEnv(options?: LLMCascadeOptions): LLMCascade;
  generate(params: GenerateParams & { stream: true }): Promise<StreamResult>;
  generate<T = any>(params: GenerateParams): Promise<GenerateResult<T>>;
  getLiveOrder(): Promise<Provider[]>;
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
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo>;
