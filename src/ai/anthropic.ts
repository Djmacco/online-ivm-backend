import { AiProviderError, LlmProvider, LlmRequest, LlmResponse } from './llm.types';

export interface AnthropicConfig { apiKey: string; model: string; url?: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** Kept so the provider can be switched back with AI_PROVIDER=anthropic. Blocks already use Anthropic's shape. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  constructor(private readonly c: AnthropicConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let res: Response;
    try {
      res = await (this.c.fetchImpl ?? fetch)(this.c.url || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.c.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.c.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.tools?.length ? { tools: req.tools } : {}),
        }),
        signal: AbortSignal.timeout(this.c.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new AiProviderError('NETWORK', (e as Error).message);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String(json?.error?.message ?? '').slice(0, 300);
      const kind = res.status === 429 ? 'QUOTA' : res.status === 401 || res.status === 403 ? 'AUTH' : res.status >= 500 ? 'UPSTREAM' : 'BAD_REQUEST';
      throw new AiProviderError(kind, msg || `HTTP ${res.status}`, res.status);
    }
    return { content: json.content ?? [], stopReason: json.stop_reason ?? 'end_turn', usage: json.usage };
  }
}
