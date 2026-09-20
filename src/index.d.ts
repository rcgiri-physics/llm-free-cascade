export type Provider =
  | 'gemini' | 'groq' | 'cerebras' | 'sambanova' | 'mistral'
  | 'openrouter' | 'together' | 'deepseek' | 'cohere' | 'huggingface'
  | 'cloudflare' | 'anthropic';

export interface LLMCascadeOptions {
  keys?: Partial<Record<Provider, string | string[]>>;
  order?: Provider[];
  models?: Partial<Record<Provider, string>>;
  cloudflareAccountId?: string;
  cooldownMs?: number;
  appName?: string;
  referer?: string;
  timeoutMs?: number;
  modelResolver?: (provider: Provider) => string | null | undefined;
  onProviderFailure?: (provider: Provider, message: string) => void;
  onProviderCooldown?: (provider: Provider, cooldownMs: number) => void;
  cooldownStore?: {
    get(provider: Provider): number | Promise<number>;
    set(provider: Provider, until: number): void | Promise<void>;
  };
}

export interface GenerateParams {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  parse?: (text: string) => any;
  timeoutMs?: number;
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

export class LLMCascadeError extends Error {
  statusCode: number;
  code: 'ALL_RATE_LIMITED' | 'ALL_PROVIDERS_FAILED' | null;
}

export class LLMCascade {
  constructor(options?: LLMCascadeOptions);
  static fromEnv(options?: LLMCascadeOptions): LLMCascade;
  generate<T = any>(params: GenerateParams): Promise<GenerateResult<T>>;
  getLiveOrder(): Promise<Provider[]>;
}

export function parseJsonLoose(text: string): any;
export function redact(message: string): string;
export const ALL_PROVIDERS: Provider[];
export const DEFAULT_MODELS: Record<Provider, string>;
