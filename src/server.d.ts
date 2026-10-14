import type { Server } from 'http';
import type { LLMCascade } from './index';

export interface CascadeServerOptions {
  /** Default: `LLMCascade.fromEnv({ maxTokensLimit: 8192, deadlineMs: 120000 })`. */
  cascade?: LLMCascade;
  /** Clients must send `Authorization: Bearer <apiKey>`. Required to bind to anything but loopback. */
  apiKey?: string;
  /** The address you will pass to `listen()`. Default `127.0.0.1`. */
  host?: string;
  log?: (line: string) => void;
}

/** An OpenAI-compatible HTTP server (`/v1/chat/completions`, `/v1/models`) in front of a cascade. Call `.listen(port, host)` yourself. */
export function createServer(options?: CascadeServerOptions): Server;
