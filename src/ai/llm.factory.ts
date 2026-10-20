import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { AiProviderError, LlmProvider, LlmRequest, LlmResponse } from './llm.types';

export const DEFAULT_MODELS = { gemini: 'gemini-3.6-flash', anthropic: 'claude-sonnet-4-6' } as const;
export type ProviderName = keyof typeof DEFAULT_MODELS;

/** Used when no key is configured: every call fails with NOT_CONFIGURED (the HTTP layer answers 503). */
class UnconfiguredProvider implements LlmProvider {
  constructor(readonly name: string) {}
  async complete(_req: LlmRequest): Promise<LlmResponse> { throw new AiProviderError('NOT_CONFIGURED', 'AI_API_KEY is not set'); }
}

export function isProviderName(v: string): v is ProviderName { return v === 'gemini' || v === 'anthropic'; }

/** Builds the provider from environment-style settings. Default provider: Gemini. */
export function createLlmProvider(get: (key: string) => string | undefined): LlmProvider {
  const raw = (get('AI_PROVIDER') || 'gemini').trim().toLowerCase();
  const name: ProviderName = isProviderName(raw) ? raw : 'gemini';
  const key = get('AI_API_KEY')?.trim();
  if (!key || key.startsWith('replace')) return new UnconfiguredProvider(name);
  const model = get('AI_MODEL')?.trim() || DEFAULT_MODELS[name];
  const url = get('AI_API_URL')?.trim() || undefined;
  if (name === 'anthropic') return new AnthropicProvider({ apiKey: key, model, url });
  const budget = get('AI_THINKING_BUDGET');
  return new GeminiProvider({ apiKey: key, model, baseUrl: url, thinkingBudget: budget !== undefined && budget !== '' && !Number.isNaN(Number(budget)) ? Number(budget) : undefined });
}
