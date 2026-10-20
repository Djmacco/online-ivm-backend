/**
 * Provider-neutral LLM contract. Messages/blocks use the shape the rest of the app already speaks
 * (text | image | tool_use | tool_result); each provider translates to and from its own API.
 */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any>; /** Gemini 3 "thought signature": opaque, must be echoed back */ thought_signature?: string }
  | { type: 'tool_result'; tool_use_id: string; name?: string; content: unknown };

export interface LlmMessage { role: 'user' | 'assistant'; content: string | Block[] }
export interface LlmTool { name: string; description: string; input_schema: Record<string, any> }

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
  /** 0 = deterministic (scan / extraction). */
  temperature?: number;
  /** Ask the model for a single JSON document (provider-native JSON mode where available). */
  json?: boolean;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'blocked' | string;
export interface LlmResponse { content: Block[]; stopReason: StopReason; usage?: { input_tokens?: number; output_tokens?: number } }

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** What went wrong, independent of the provider. The service turns these into friendly HTTP errors. */
export type AiErrorKind =
  | 'NOT_CONFIGURED' // no key
  | 'AUTH'           // key rejected / not allowed (a SERVER misconfiguration, never the user's fault)
  | 'BAD_REQUEST'    // wrong model name, bad parameters
  | 'QUOTA'          // rate limit / free-tier quota
  | 'UPSTREAM'       // provider 5xx
  | 'NETWORK'        // unreachable / timeout
  | 'BLOCKED'        // safety filter refused the content
  | 'EMPTY';         // model answered nothing usable

export class AiProviderError extends Error {
  constructor(public readonly kind: AiErrorKind, message: string, public readonly status?: number) {
    super(message);
  }
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
