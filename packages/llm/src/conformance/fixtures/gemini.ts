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

// Streamed thought parts (thought: true) then the answer — exercises the reasoning channel (ADR-0030).
const reasoningStream = JSON.stringify([
  {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'let me think', thought: true, thoughtSignature: 'sig-g' }],
        },
      },
    ],
  },
  {
    candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
  },
]);

const structuredOutput = JSON.stringify({
  candidates: [
    { content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
});

// A recorded Imagen (generateImages) reply — a single base64 image, the SYNC generative seam path
// (1.AH A2). The Gemini conformance harness replays it through the fake transport's generateImages, so
// it drives the real fold/normalization (generatedImages[].image.imageBytes → a base64 `media` part)
// with no vendor import. The base64 matches the OpenAI fixture for cross-adapter parity.
const imageGenerate = JSON.stringify({
  generatedImages: [
    { image: { imageBytes: 'aGVsbG8tY29uZm9ybWFuY2UtaW1hZ2U=', mimeType: 'image/png' } },
  ],
});

// A recorded `models.list()` reply (ADR-0064 §1) — recorded at the SDK-output level (a `GeminiModelInfo[]`
// the fake transport returns), like the other Gemini fixtures. FILTER: keep only chat-capable models
// (`supportedActions` includes `generateContent`); the embedding row is dropped. MAP: strip the `models/`
// prefix, `inputTokenLimit`→contextWindowTokens, `outputTokenLimit`→maxOutputTokens.
const modelsList = JSON.stringify([
  {
    name: 'models/gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent', 'countTokens'],
  },
  {
    name: 'models/gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent'],
  },
  {
    name: 'models/text-embedding-004',
    displayName: 'Text Embedding 004',
    inputTokenLimit: 2_048,
    outputTokenLimit: 1,
    supportedActions: ['embedContent'], // no generateContent → filtered out
  },
]);

// The drift fixture (ADR-0064 §8): one row carries an unknown future field (ignored); one chat-capable row
// has NO `name` (→ no id → dropped at the mapper boundary), never a throw.
const modelsListDrift = JSON.stringify([
  {
    name: 'models/gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent'],
    someUnknownFutureField: 'ignore-me',
  },
  {
    displayName: 'Name-less Model', // no `name` → no id → dropped
    inputTokenLimit: 1_000,
    outputTokenLimit: 1_000,
    supportedActions: ['generateContent'],
  },
]);

export const GEMINI_FIXTURES: ConformanceFixtures = {
  textGenerate: { status: 200, body: textResponse },
  toolGenerate: { status: 200, body: toolResponse },
  textStream: { status: 200, body: textStream },
  toolStream: { status: 200, body: toolStream },
  rateLimit: { status: 429, body: rateLimitError },
  streamError: { status: 503, body: overloadedError },
  reasoningStream: { status: 200, body: reasoningStream },
  structuredOutput: { status: 200, body: structuredOutput },
  mediaGenerate: { status: 200, body: imageGenerate },
  listModels: { status: 200, body: modelsList },
  listModelsDrift: { status: 200, body: modelsListDrift },
  toolLoop: {
    turn1: { status: 200, body: toolResponse },
    turn2: { status: 200, body: textResponse },
    expected: { toolName: 'get_weather', finalText: 'Hello, world!' },
  },
  expected: {
    textGenerate: { stopReason: 'stop', text: 'Hello, world!', inputTokens: 12, outputTokens: 7 },
    toolGenerate: { toolName: 'get_weather', stopReason: 'tool_use' },
    textStream: { stopReason: 'stop', inputTokens: 12, outputTokens: 7 },
    toolStream: { toolName: 'get_weather', stopReason: 'tool_use' },
    streamErrorKind: 'overloaded',
    reasoningStream: { text: 'let me think', reasoningTokens: 2 },
    structuredOutput: { text: '{"ok":true}' },
    mediaGenerate: { mimeType: 'image/png', data: 'aGVsbG8tY29uZm9ybWFuY2UtaW1hZ2U=' },
    listModels: {
      ids: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      // `models/`-prefix stripped; inputTokenLimit→contextWindowTokens, outputTokenLimit→maxOutputTokens.
      sample: {
        id: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
      },
    },
    listModelsDrift: { ids: ['gemini-2.5-flash'] },
  },
};
