import type { ConformanceFixtures } from '../spec.js';

/**
 * Hand-authored Gemini conformance fixtures (1.H). Unlike the Anthropic/OpenAI fixtures (raw HTTP
 * bodies the SDK parses), `@google/genai` has no `fetch` hook, so these are recorded at the
 * **SDK-output level** — `body` is the JSON of a `GenerateContentResponse` (non-streaming) or a JSON
 * array of streamed responses — and the Gemini conformance test injects them through a fake
 * `GeminiTransport`. That still exercises the full fold/normalization (the part conformance proves)
 * with no vendor import. **Regenerate, don't hand-edit, once a live key records fresh ones.**
 */

const textResponse = JSON.stringify({
  candidates: [
    { content: { role: 'model', parts: [{ text: 'Hello, world!' }] }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
});

const toolResponse = JSON.stringify({
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
      },
      finishReason: 'STOP', // STOP + a tool call normalizes to tool_use
    },
  ],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 },
});

const textStream = JSON.stringify([
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello, ' }] } }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ text: 'world!' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
  },
]);

const toolStream = JSON.stringify([
  {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 },
  },
]);

const rateLimitError = JSON.stringify({
  error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' },
});

const overloadedError = JSON.stringify({
  error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' },
});

export const GEMINI_FIXTURES: ConformanceFixtures = {
  textGenerate: { status: 200, body: textResponse },
  toolGenerate: { status: 200, body: toolResponse },
  textStream: { status: 200, body: textStream },
  toolStream: { status: 200, body: toolStream },
  rateLimit: { status: 429, body: rateLimitError },
  streamError: { status: 503, body: overloadedError },
  expected: {
    textGenerate: { stopReason: 'stop', text: 'Hello, world!', inputTokens: 12, outputTokens: 7 },
    toolGenerate: { toolName: 'get_weather', stopReason: 'tool_use' },
    textStream: { stopReason: 'stop', inputTokens: 12, outputTokens: 7 },
    toolStream: { toolName: 'get_weather', stopReason: 'tool_use' },
    streamErrorKind: 'overloaded',
  },
};
