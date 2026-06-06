import type { ConformanceFixtures } from '../spec.js';

/**
 * Hand-authored DeepSeek conformance fixtures (1.G) — DeepSeek speaks the OpenAI-compatible wire, so
 * these mirror the OpenAI shapes with the `deepseek-chat` model id and DeepSeek's own cache field
 * (`prompt_cache_hit_tokens`), which exercises the gross→net usage path distinctly from OpenAI's
 * `prompt_tokens_details.cached_tokens`. **Regenerate, don't hand-edit, once a live key records
 * fresh ones** (testing.md).
 */

const textMessage = JSON.stringify({
  id: 'chatcmpl_ds_text',
  object: 'chat.completion',
  created: 0,
  model: 'deepseek-chat',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello, world!' },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  // DeepSeek reports the cache hit at the top level — 4 of the 12 prompt tokens were cached.
  usage: {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_cache_hit_tokens: 4,
    prompt_cache_miss_tokens: 8,
  },
});

const toolMessage = JSON.stringify({
  id: 'chatcmpl_ds_tool',
  object: 'chat.completion',
  created: 0,
  model: 'deepseek-chat',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_ds_weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
});

const rateLimitError = JSON.stringify({
  error: {
    message: 'Rate limit reached',
    type: 'rate_limit_exceeded',
    code: 'rate_limit_exceeded',
  },
});

function sse(chunks: readonly unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const chunk = (
  choices: readonly unknown[],
  usage?: Record<string, number>,
): Record<string, unknown> => ({
  id: 'chatcmpl_ds_stream',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'deepseek-chat',
  choices,
  ...(usage === undefined ? {} : { usage }),
});

const textStream = sse([
  chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
  chunk([{ index: 0, delta: { content: 'Hello, ' }, finish_reason: null }]),
  chunk([{ index: 0, delta: { content: 'world!' }, finish_reason: null }]),
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  chunk([], {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_cache_hit_tokens: 4,
  }),
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
            id: 'call_ds_weather',
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

const streamError = JSON.stringify({
  error: { message: 'Service overloaded', type: 'server_error', code: null },
});

export const DEEPSEEK_FIXTURES: ConformanceFixtures = {
  textGenerate: { status: 200, body: textMessage },
  toolGenerate: { status: 200, body: toolMessage },
  textStream: { status: 200, contentType: 'text/event-stream', body: textStream },
  toolStream: { status: 200, contentType: 'text/event-stream', body: toolStream },
  rateLimit: { status: 429, body: rateLimitError },
  streamError: { status: 503, body: streamError },
  expected: {
    // 4 of 12 prompt tokens cached → net input 8, cacheRead 4.
    textGenerate: { stopReason: 'stop', text: 'Hello, world!', inputTokens: 8, outputTokens: 7 },
    toolGenerate: { toolName: 'get_weather', stopReason: 'tool_use' },
    textStream: { stopReason: 'stop', inputTokens: 8, outputTokens: 7 },
    toolStream: { toolName: 'get_weather', stopReason: 'tool_use' },
    streamErrorKind: 'overloaded',
  },
};
