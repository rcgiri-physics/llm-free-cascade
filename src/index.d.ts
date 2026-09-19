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
}

export interface GenerateParams {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  parse?: (text: string) => any;
}

export interface GenerateResult<T = any> {
  text: string;
  parsed: T | undefined;
  provider: Provider;
}

export class LLMCascadeError extends Error {
  statusCode: number;
  code: 'ALL_RATE_LIMITED' | 'ALL_PROVIDERS_FAILED' | null;
}

export class LLMCascade {
  constructor(options?: LLMCascadeOptions);
  static fromEnv(options?: LLMCascadeOptions): LLMCascade;
  generate<T = any>(params: GenerateParams): Promise<GenerateResult<T>>;
}

export function parseJsonLoose(text: string): any;
export const ALL_PROVIDERS: Provider[];
export const DEFAULT_MODELS: Record<Provider, string>;
