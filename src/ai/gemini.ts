import { randomUUID } from 'crypto';
import { AiProviderError, Block, LlmProvider, LlmRequest, LlmResponse } from './llm.types';

export interface GeminiConfig {
  apiKey: string;
  /** e.g. gemini-3.6-flash */
  model: string;
  /** default https://generativelanguage.googleapis.com/v1beta */
  baseUrl?: string;
  /** Optional. 0 turns "thinking" off on models that allow it (faster/cheaper; thinking tokens also eat the output budget). */
  thinkingBudget?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Keys of JSON Schema that the Gemini function-declaration subset rejects. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties', 'patternProperties', 'unevaluatedProperties',
  'examples', 'default', 'title', 'const', 'exclusiveMinimum', 'exclusiveMaximum', 'readOnly', 'writeOnly', 'deprecated',
]);

/** JSON Schema → the OpenAPI-style subset Gemini accepts for function parameters. Pure. */
export function cleanSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) { // ["string","null"] -> string + nullable
      const types = v.filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (v.includes('null')) out.nullable = true;
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, cleanSchema(pv)]));
      continue;
    }
    out[k] = k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf' ? cleanSchema(v) : v;
  }
  if (Array.isArray(out.oneOf)) { out.anyOf = out.oneOf; delete out.oneOf; }
  if (Array.isArray(out.required) && out.properties) out.required = out.required.filter((r: string) => r in out.properties);
  return out;
}

/** functionResponse.response must be a JSON object. */
export function toResponseObject(content: unknown): Record<string, unknown> {
  let v: unknown = content;
  if (Array.isArray(v)) v = v.map((b: any) => (b && typeof b === 'object' && 'text' in b ? b.text : b)).join('\n');
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* plain text */ }
    return { result: v };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return { result: v ?? null };
}

/** Pure: build the generateContent request body. */
export function toGeminiRequest(req: LlmRequest, opts: { thinkingBudget?: number } = {}): Record<string, any> {
  const toolNames = new Map<string, string>(); // tool_use id -> name, needed to answer with a functionResponse
  const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];

  for (const m of req.messages) {
    const parts: any[] = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const b of m.content) {
        if (b.type === 'text') parts.push({ text: b.text });
        else if (b.type === 'image') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
        else if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name);
          parts.push({ functionCall: { name: b.name, args: b.input ?? {} }, ...(b.thought_signature ? { thoughtSignature: b.thought_signature } : {}) });
        } else if (b.type === 'tool_result') {
          parts.push({ functionResponse: { name: toolNames.get(b.tool_use_id) ?? b.name ?? 'tool', response: toResponseObject(b.content) } });
        }
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  const generationConfig: Record<string, any> = { maxOutputTokens: req.maxTokens, temperature: req.temperature ?? 0.2 };
  if (req.json) generationConfig.responseMimeType = 'application/json';
  if (opts.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };

  const body: Record<string, any> = { contents, generationConfig };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const decls = (req.tools ?? []).map((t) => {
    const params = cleanSchema(t.input_schema);
    const hasParams = params && params.properties && Object.keys(params.properties).length > 0;
    return { name: t.name, description: t.description, ...(hasParams ? { parameters: params } : {}) };
  });
  if (decls.length) body.tools = [{ functionDeclarations: decls }];
  return body;
}

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

/** Pure: generateContent response → neutral response. Throws AiProviderError for blocked / empty answers. */
export function fromGeminiResponse(json: any): LlmResponse {
  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason) throw new AiProviderError('BLOCKED', `Prompt blocked: ${blockReason}`);
  const cand = json?.candidates?.[0];
  if (!cand) throw new AiProviderError('EMPTY', 'No candidates returned');

  const blocks: Block[] = [];
  for (const p of cand.content?.parts ?? []) {
    if (p?.thought === true) continue; // thought summaries are not part of the answer
    if (typeof p?.text === 'string' && p.text.length) blocks.push({ type: 'text', text: p.text });
    else if (p?.functionCall?.name) {
      blocks.push({
        type: 'tool_use', id: `call_${randomUUID().slice(0, 12)}`, name: p.functionCall.name, input: p.functionCall.args ?? {},
        ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {}),
      });
    }
  }
  const finish: string | undefined = cand.finishReason;
  if (!blocks.length) {
    if (finish && BLOCKED_FINISH.has(finish)) throw new AiProviderError('BLOCKED', `Response blocked: ${finish}`);
    throw new AiProviderError('EMPTY', `Empty answer${finish ? ` (${finish})` : ''}`);
  }
  const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish && BLOCKED_FINISH.has(finish) ? 'blocked' : 'end_turn';
  return {
    content: blocks, stopReason,
    usage: { input_tokens: json.usageMetadata?.promptTokenCount, output_tokens: json.usageMetadata?.candidatesTokenCount },
  };
}

/** Maps an upstream HTTP failure to a neutral kind. Google reports a bad API key as HTTP 400 ("API key not valid"). */
export function classifyGeminiError(status: number, body: any): AiProviderError {
  const msg = String(body?.error?.message ?? '').slice(0, 300);
  const code = String(body?.error?.status ?? '');
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return new AiProviderError('QUOTA', msg || 'Quota exceeded', status);
  if (status === 401 || status === 403 || code === 'PERMISSION_DENIED' || code === 'UNAUTHENTICATED' || /api key/i.test(msg)) return new AiProviderError('AUTH', msg || 'Key rejected', status);
  if (status === 404 || status === 400 || code === 'INVALID_ARGUMENT' || code === 'NOT_FOUND') return new AiProviderError('BAD_REQUEST', msg || 'Bad request', status);
  return new AiProviderError('UPSTREAM', msg || `HTTP ${status}`, status);
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  constructor(private readonly c: GeminiConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = (this.c.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(this.c.model)}:generateContent`;
    let res: Response;
    try {
      res = await (this.c.fetchImpl ?? fetch)(url, {
        method: 'POST',
        // key in a HEADER, never in the URL: URLs end up in logs and error messages
        headers: { 'x-goog-api-key': this.c.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(toGeminiRequest(req, { thinkingBudget: this.c.thinkingBudget })),
        signal: AbortSignal.timeout(this.c.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new AiProviderError('NETWORK', (e as Error).message);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw classifyGeminiError(res.status, json);
    return fromGeminiResponse(json);
  }
}
