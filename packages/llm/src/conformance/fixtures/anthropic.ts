import type { ConformanceFixtures } from '../spec.js';

/**
 * Hand-authored Anthropic conformance fixtures (1.F) — recorded-shape Messages API responses for
 * each canonical scenario, modelled on the documented wire format (JSON for non-streaming, an SSE
 * transcript for streams). They drive the real SDK parser + our normalization offline. **Regenerate,
 * don't hand-edit, once a live key records fresh ones** (testing.md); these seed PR mode until then.
 */

const textMessage = JSON.stringify({
  id: 'msg_text',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-8',
  content: [{ type: 'text', text: 'Hello, world!' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 7 },
});

const toolMessage = JSON.stringify({
  id: 'msg_tool',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-8',
  content: [
    { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 15 },
});

const rateLimitError = JSON.stringify({
  type: 'error',
  error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' },
});

/** Build an SSE transcript from `[eventType, dataObject]` pairs in the Anthropic wire format. */
function sse(events: readonly [string, unknown][]): string {
  return (
    events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('') +
    '\n'
  );
}

const textStream = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_text_stream',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

const toolStream = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_tool_stream',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: {} },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 15 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

// A stream that starts, then emits a mid-stream `error` event (HTTP 200, SSE) — the SDK raises on
// the error event, which the adapter catches and folds into an `error` StreamChunk.
const streamError = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_err_stream',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
]);

// A stream with a thinking block (thinking + signature deltas) then text — exercises the reasoning
// channel (ADR-0030): thinking_delta → reasoning_delta, signature_delta → reasoning_end signature.
const reasoningStream = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_reasoning',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 6, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'let me think' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-xyz' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      // The terminal message_delta carries the authoritative cumulative thinking count in
      // output_tokens_details — the real wire shape the streaming usage merge must read (ADR-0030).
      usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

// A non-streaming reply produced under responseFormat: json — the content is a JSON document.
const structuredOutput = JSON.stringify({
  id: 'msg_json',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-8',
  content: [{ type: 'text', text: '{"ok":true}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 4 },
});

export const ANTHROPIC_FIXTURES: ConformanceFixtures = {
  textGenerate: { status: 200, body: textMessage },
  toolGenerate: { status: 200, body: toolMessage },
  textStream: { status: 200, contentType: 'text/event-stream', body: textStream },
  toolStream: { status: 200, contentType: 'text/event-stream', body: toolStream },
  rateLimit: { status: 429, body: rateLimitError },
  streamError: { status: 200, contentType: 'text/event-stream', body: streamError },
  reasoningStream: { status: 200, contentType: 'text/event-stream', body: reasoningStream },
  structuredOutput: { status: 200, body: structuredOutput },
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
    reasoningStream: { text: 'let me think', reasoningTokens: 4 },
    structuredOutput: { text: '{"ok":true}' },
  },
};
