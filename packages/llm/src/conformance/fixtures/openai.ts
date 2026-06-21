import type { ConformanceFixtures } from '../spec.js';

/**
 * Hand-authored OpenAI conformance fixtures (1.G) — recorded-shape Chat Completions responses for
 * each canonical scenario (JSON for non-streaming, an SSE `data:` transcript for streams). They drive
 * the real `openai` SDK parser + our normalization offline. **Regenerate, don't hand-edit, once a
 * live key records fresh ones** (testing.md); these seed PR mode until then.
 */

const textMessage = JSON.stringify({
  id: 'chatcmpl_text',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello, world!', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 0 },
  },
});

const toolMessage = JSON.stringify({
  id: 'chatcmpl_tool',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
        refusal: null,
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
});

const rateLimitError = JSON.stringify({
  error: {
    message: 'Rate limit reached for requests',
    type: 'rate_limit_exceeded',
    code: 'rate_limit_exceeded',
  },
});

/** Build an OpenAI SSE transcript from chunk objects: `data: {json}` frames + a `[DONE]` sentinel. */
function sse(chunks: readonly unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const chunk = (
  choices: readonly unknown[],
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): Record<string, unknown> => ({
  id: 'chatcmpl_stream',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'gpt-4o',
  choices,
  ...(usage === undefined ? {} : { usage }),
});

const textStream = sse([
  chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
  chunk([{ index: 0, delta: { content: 'Hello, ' }, finish_reason: null }]),
  chunk([{ index: 0, delta: { content: 'world!' }, finish_reason: null }]),
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  // include_usage tail: a final chunk with empty choices carrying the usage.
  chunk([], { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }),
]);

const toolStream = sse([
  chunk([
    {
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ],
      },
      finish_reason: null,
    },
  ]),
  chunk([
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
      finish_reason: null,
    },
  ]),
  chunk([
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
      finish_reason: null,
    },
  ]),
  chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
  chunk([], { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 }),
]);

// A 503 on the streaming request — the SDK raises before streaming starts; the adapter's init catch
// folds it into a classified `error` StreamChunk (overloaded → retryable).
const streamError = JSON.stringify({
  error: { message: 'The server is overloaded', type: 'server_error', code: null },
});

// A non-streaming reply produced under responseFormat: json — the content is a JSON document.
const structuredOutput = JSON.stringify({
  id: 'chatcmpl_json',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '{"ok":true}', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
});

// A recorded images.generate (gpt-image-1) reply — a single base64 image, the SYNC generative seam path
// (1.AG Section C). The OpenAI SDK's images.generate goes through the same `fetch` override, so this drives
// the real parser + our normalization offline (b64_json → a base64 `media` part, mimeType image/png default).
const imageGenerate = JSON.stringify({
  created: 0,
  data: [{ b64_json: 'aGVsbG8tY29uZm9ybWFuY2UtaW1hZ2U=' }],
});

// No reasoningStream fixture: OpenAI chat.completions emits no reasoning output (the conformance
// reasoning scenario is skipped for this provider).
export const OPENAI_FIXTURES: ConformanceFixtures = {
  textGenerate: { status: 200, body: textMessage },
  toolGenerate: { status: 200, body: toolMessage },
  textStream: { status: 200, contentType: 'text/event-stream', body: textStream },
  toolStream: { status: 200, contentType: 'text/event-stream', body: toolStream },
  rateLimit: { status: 429, body: rateLimitError },
  streamError: { status: 503, body: streamError },
  structuredOutput: { status: 200, body: structuredOutput },
  mediaGenerate: { status: 200, body: imageGenerate },
  toolLoop: {
    turn1: { status: 200, body: toolMessage },
    turn2: { status: 200, body: textMessage },
    expected: { toolName: 'get_weather', finalText: 'Hello, world!' },
  },
  expected: {
    textGenerate: { stopReason: 'stop', text: 'Hello, world!', inputTokens: 12, outputTokens: 7 },
    toolGenerate: { toolName: 'get_weather', stopReason: 'tool_use' },
    textStream: { stopReason: 'stop', inputTokens: 12, outputTokens: 7 },
    toolStream: { toolName: 'get_weather', stopReason: 'tool_use' },
    streamErrorKind: 'overloaded',
    structuredOutput: { text: '{"ok":true}' },
    mediaGenerate: { mimeType: 'image/png', data: 'aGVsbG8tY29uZm9ybWFuY2UtaW1hZ2U=' },
  },
};
