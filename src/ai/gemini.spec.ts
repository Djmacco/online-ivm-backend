import { classifyGeminiError, cleanSchema, fromGeminiResponse, GeminiProvider, toGeminiRequest, toResponseObject } from './gemini';
import { createLlmProvider } from './llm.factory';
import { AiProviderError } from './llm.types';

const ok = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body }) as any;

describe('toGeminiRequest', () => {
  it('maps system, roles, images, JSON mode, temperature and thinking budget', () => {
    const body = toGeminiRequest({
      system: 'be brief', maxTokens: 300, temperature: 0, json: true,
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what is this' }] },
        { role: 'assistant', content: 'a shelf' },
        { role: 'user', content: 'thanks' },
      ],
    }, { thinkingBudget: 0 });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 300, temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
    expect(body.tools).toBeUndefined();
  });

  it('thinking config and JSON mode are only sent when asked for', () => {
    const body = toGeminiRequest({ system: '', maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 10, temperature: 0.2 });
    expect(body.systemInstruction).toBeUndefined();
  });

  it('translates tools and a full tool round-trip (functionCall → functionResponse, thought signature preserved)', () => {
    const body = toGeminiRequest({
      system: 's', maxTokens: 100,
      tools: [
        { name: 'getStock', description: 'stock of a product', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] } },
        { name: 'getToday', description: 'no params', input_schema: { type: 'object', properties: {} } },
      ],
      messages: [
        { role: 'user', content: 'combien de coca ?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'getStock', input: { name: 'coca' }, thought_signature: 'SIG==' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"quantity": 12}' }] },
      ],
    });
    const [decl1, decl2] = body.tools[0].functionDeclarations;
    expect(decl1).toEqual({ name: 'getStock', description: 'stock of a product', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } });
    expect(decl2).toEqual({ name: 'getToday', description: 'no params' }); // empty parameters are omitted (Gemini rejects them)
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'getStock', args: { name: 'coca' } }, thoughtSignature: 'SIG==' }] });
    expect(body.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'getStock', response: { quantity: 12 } } }] });
  });
});

describe('schema + result helpers', () => {
  it('cleanSchema strips what Gemini rejects, keeps the rest, and converts nullable types', () => {
    expect(cleanSchema({
      $schema: 'x', type: 'object', additionalProperties: false, title: 'T',
      properties: { a: { type: ['string', 'null'], default: 'x' }, b: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } }, c: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['a', 'ghost'],
    })).toEqual({
      type: 'object',
      properties: { a: { type: 'string', nullable: true }, b: { type: 'array', items: { type: 'number' } }, c: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['a'],
    });
  });
  it('functionResponse payloads are always JSON objects', () => {
    expect(toResponseObject('{"ok":true}')).toEqual({ ok: true });
    expect(toResponseObject('plain text')).toEqual({ result: 'plain text' });
    expect(toResponseObject('[1,2]')).toEqual({ result: '[1,2]' });
    expect(toResponseObject([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ result: 'a\nb' });
    expect(toResponseObject({ x: 1 })).toEqual({ x: 1 });
    expect(toResponseObject(null)).toEqual({ result: null });
  });
});

describe('fromGeminiResponse', () => {
  const resp = (parts: any[], finishReason = 'STOP', extra: any = {}) => ({ candidates: [{ content: { parts }, finishReason }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }, ...extra });

  it('text answer', () => {
    expect(fromGeminiResponse(resp([{ text: 'Bonjour' }]))).toEqual({ content: [{ type: 'text', text: 'Bonjour' }], stopReason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } });
  });
  it('function calls become tool_use blocks (with ids and the thought signature) and stop_reason tool_use', () => {
    const r = fromGeminiResponse(resp([{ text: 'Je vérifie.' }, { functionCall: { name: 'getStock', args: { name: 'coca' } }, thoughtSignature: 'SIG' }]));
    expect(r.stopReason).toBe('tool_use');
    expect(r.content[1]).toMatchObject({ type: 'tool_use', name: 'getStock', input: { name: 'coca' }, thought_signature: 'SIG' });
    expect((r.content[1] as any).id).toMatch(/^call_/);
  });
  it('thought summaries are not part of the answer; MAX_TOKENS is reported', () => {
    const r = fromGeminiResponse(resp([{ text: 'thinking…', thought: true }, { text: '{"detections":[' }], 'MAX_TOKENS'));
    expect(r.content).toEqual([{ type: 'text', text: '{"detections":[' }]);
    expect(r.stopReason).toBe('max_tokens');
  });
  it('safety blocks and empty answers raise typed errors', () => {
    expect(() => fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(expect.objectContaining({ kind: 'BLOCKED' }));
    expect(() => fromGeminiResponse(resp([], 'SAFETY'))).toThrow(expect.objectContaining({ kind: 'BLOCKED' }));
    expect(() => fromGeminiResponse(resp([], 'STOP'))).toThrow(expect.objectContaining({ kind: 'EMPTY' }));
    expect(() => fromGeminiResponse({})).toThrow(expect.objectContaining({ kind: 'EMPTY' }));
  });
});

describe('classifyGeminiError', () => {
  it('Google reports an invalid API key as HTTP 400 – still an AUTH problem, not a bad request', () => {
    expect(classifyGeminiError(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }).kind).toBe('AUTH');
  });
  it('maps the other statuses', () => {
    expect(classifyGeminiError(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }).kind).toBe('QUOTA');
    expect(classifyGeminiError(403, { error: { status: 'PERMISSION_DENIED' } }).kind).toBe('AUTH');
    expect(classifyGeminiError(404, { error: { status: 'NOT_FOUND', message: 'models/foo is not found' } }).kind).toBe('BAD_REQUEST');
    expect(classifyGeminiError(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad thinking config' } }).kind).toBe('BAD_REQUEST');
    expect(classifyGeminiError(503, {}).kind).toBe('UPSTREAM');
  });
});

describe('GeminiProvider over HTTP (mocked fetch)', () => {
  const req = { system: 's', maxTokens: 50, messages: [{ role: 'user' as const, content: 'hi' }] };

  it('POSTs to models/{model}:generateContent with the key in a header, never in the URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ candidates: [{ content: { parts: [{ text: 'yo' }] }, finishReason: 'STOP' }] }));
    const p = new GeminiProvider({ apiKey: 'SECRET-KEY', model: 'gemini-3.6-flash', fetchImpl });
    const r = await p.complete(req);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(String(url)).not.toContain('SECRET-KEY');
    expect(init.headers['x-goog-api-key']).toBe('SECRET-KEY');
    expect(JSON.parse(init.body).contents[0].parts[0].text).toBe('hi');
    expect(r.content).toEqual([{ type: 'text', text: 'yo' }]);
  });
  it('honours a custom base URL (proxy / gateway) and model names are URL-safe', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
    await new GeminiProvider({ apiKey: 'k', model: 'models/odd name', baseUrl: 'https://gw.example.com/v1beta/', fetchImpl }).complete(req);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gw.example.com/v1beta/models/models%2Fodd%20name:generateContent');
  });
  it('HTTP errors and network failures become typed errors', async () => {
    const bad = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl: jest.fn().mockResolvedValue(ok({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429)) });
    await expect(bad.complete(req)).rejects.toMatchObject({ kind: 'QUOTA', status: 429 });
    const down = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNRESET')) });
    await expect(down.complete(req)).rejects.toMatchObject({ kind: 'NETWORK' });
  });
});

describe('createLlmProvider (AI_PROVIDER switch)', () => {
  const env = (o: Record<string, string | undefined>) => (k: string) => o[k];
  it('defaults to Gemini with the default model; the provider name is exposed', () => {
    expect(createLlmProvider(env({ AI_API_KEY: 'k' })).name).toBe('gemini');
    expect(createLlmProvider(env({ AI_API_KEY: 'k', AI_PROVIDER: 'GEMINI' })).name).toBe('gemini');
  });
  it('can switch back to Anthropic', () => {
    expect(createLlmProvider(env({ AI_API_KEY: 'k', AI_PROVIDER: 'anthropic' })).name).toBe('anthropic');
  });
  it('no key / placeholder key → every call fails with NOT_CONFIGURED', async () => {
    for (const e of [{}, { AI_API_KEY: 'replace-me' }, { AI_API_KEY: '  ' }]) {
      await expect(createLlmProvider(env(e)).complete({ system: '', maxTokens: 1, messages: [] })).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    }
  });
  it('uses AI_MODEL, AI_API_URL and AI_THINKING_BUDGET', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(ok({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
    await createLlmProvider(env({ AI_API_KEY: 'k', AI_MODEL: 'gemini-3.8-flash', AI_API_URL: 'https://gw/v1beta', AI_THINKING_BUDGET: '0' })).complete({ system: '', maxTokens: 5, messages: [{ role: 'user', content: 'a' }] });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://gw/v1beta/models/gemini-3.8-flash:generateContent');
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as any).body).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    fetchSpy.mockRestore();
  });
});
