import type { ExpectedExchange, JsonValue } from '../exchange-replay.js';
import type { RecordedResponse } from '../replay.js';

/** Synthetic protocol seeds, authored independently of adapter lowering or captured requests. */
export type WireProvider = 'anthropic' | 'openai' | 'deepseek' | 'gemini';
export type WireMethod = 'generate' | 'stream';
export type WireScenario = 'structured' | 'named' | 'continuation' | 'final';

const jsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
const weatherSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};
const anthropicTools = [
  {
    name: 'get_weather',
    description: 'Look up weather for a city.',
    input_schema: weatherSchema,
  },
];
const openaiTools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Look up weather for a city.',
      parameters: weatherSchema,
    },
  },
];
const geminiTools = [
  {
    functionDeclarations: [
      {
        name: 'get_weather',
        description: 'Look up weather for a city.',
        parameters: {
          type: 'OBJECT',
          properties: { city: { type: 'STRING' } },
          required: ['city'],
        },
      },
    ],
  },
];

// These are wire literals, never built from the canonical request or a production mapper.
const structuredBodies: Record<WireProvider, Record<string, JsonValue>> = {
  anthropic: {
    model: 'w8-wire-anthropic',
    max_tokens: 37,
    system: 'Return the requested JSON object.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }],
    temperature: 0.25,
    stop_sequences: ['END'],
    output_config: { format: { type: 'json_schema', schema: jsonSchema } },
  },
  openai: {
    model: 'w8-wire-openai',
    max_completion_tokens: 37,
    messages: [
      { role: 'system', content: 'Return the requested JSON object.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    temperature: 0.25,
    stop: ['END'],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'wire_result', strict: true, schema: jsonSchema },
    },
  },
  deepseek: {
    model: 'w8-wire-deepseek',
    max_tokens: 37,
    messages: [
      { role: 'system', content: 'Return the requested JSON object.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    temperature: 0.25,
    stop: ['END'],
    response_format: { type: 'json_object' },
  },
  gemini: {
    contents: [{ role: 'user', parts: [{ text: 'Return JSON.' }] }],
    systemInstruction: { role: 'user', parts: [{ text: 'Return the requested JSON object.' }] },
    generationConfig: {
      maxOutputTokens: 37,
      temperature: 0.25,
      stopSequences: ['END'],
      responseMimeType: 'application/json',
      responseJsonSchema: jsonSchema,
    },
  },
};
const toolBodies: Record<WireProvider, Record<string, JsonValue>> = {
  anthropic: {
    model: 'w8-wire-anthropic',
    max_tokens: 37,
    system: 'Use weather information to answer.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] }],
    tools: anthropicTools,
  },
  openai: {
    model: 'w8-wire-openai',
    max_completion_tokens: 37,
    messages: [
      { role: 'system', content: 'Use weather information to answer.' },
      { role: 'user', content: 'Weather in Paris?' },
    ],
    tools: openaiTools,
  },
  deepseek: {
    model: 'w8-wire-deepseek',
    max_tokens: 37,
    messages: [
      { role: 'system', content: 'Use weather information to answer.' },
      { role: 'user', content: 'Weather in Paris?' },
    ],
    tools: openaiTools,
  },
  gemini: {
    contents: [{ role: 'user', parts: [{ text: 'Weather in Paris?' }] }],
    systemInstruction: { role: 'user', parts: [{ text: 'Use weather information to answer.' }] },
    generationConfig: { maxOutputTokens: 37 },
    tools: geminiTools,
  },
};
const finalMessages: Record<WireProvider, JsonValue> = {
  anthropic: [
    { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Check the weather.', signature: 'wire-anthropic-thought' },
        {
          type: 'tool_use',
          id: 'toolu_wire_weather',
          name: 'get_weather',
          input: { city: 'Paris' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_wire_weather',
          content: '{"forecast":"sunny","temperatureC":18}',
        },
      ],
    },
  ],
  openai: [
    { role: 'system', content: 'Use weather information to answer.' },
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_wire_weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_wire_weather',
      content: '{"forecast":"sunny","temperatureC":18}',
    },
  ],
  deepseek: [
    { role: 'system', content: 'Use weather information to answer.' },
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_wire_weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_wire_weather',
      content: '{"forecast":"sunny","temperatureC":18}',
    },
  ],
  gemini: [
    { role: 'user', parts: [{ text: 'Weather in Paris?' }] },
    {
      role: 'model',
      parts: [
        { text: 'Check the weather.', thought: true, thoughtSignature: 'wire-gemini-thought' },
        {
          functionCall: { name: 'get_weather', args: { city: 'Paris' } },
          thoughtSignature: 'wire-gemini-call',
        },
      ],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'get_weather',
            response: { forecast: 'sunny', temperatureC: 18 },
          },
        },
      ],
    },
  ],
};

function expectedBody(
  provider: WireProvider,
  method: WireMethod,
  scenario: WireScenario,
): JsonValue {
  const body = {
    ...(scenario === 'structured' ? structuredBodies[provider] : toolBodies[provider]),
  };
  if (scenario === 'named' || scenario === 'continuation' || scenario === 'final') {
    const named = scenario === 'named';
    if (provider === 'anthropic')
      body['tool_choice'] = named ? { type: 'tool', name: 'get_weather' } : { type: 'auto' };
    else if (provider === 'gemini')
      body['toolConfig'] = {
        functionCallingConfig: named
          ? { mode: 'ANY', allowedFunctionNames: ['get_weather'] }
          : { mode: 'AUTO' },
      };
    else
      body['tool_choice'] = named
        ? { type: 'function', function: { name: 'get_weather' } }
        : 'auto';
  }
  if (scenario === 'final')
    body[provider === 'gemini' ? 'contents' : 'messages'] = finalMessages[provider];
  if (provider !== 'gemini') {
    body['stream'] = method === 'stream';
    if (method === 'stream' && provider !== 'anthropic')
      body['stream_options'] = { include_usage: true };
  }
  return body;
}

const anthropicUsage = {
  input_tokens: 12,
  output_tokens: 7,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const geminiUsage = {
  promptTokenCount: 12,
  candidatesTokenCount: 7,
  totalTokenCount: 19,
  cachedContentTokenCount: 0,
  thoughtsTokenCount: 0,
  toolUsePromptTokenCount: 0,
};
const openaiUsage = {
  prompt_tokens: 12,
  completion_tokens: 7,
  total_tokens: 19,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};
const deepseekUsage = { ...openaiUsage, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12 };

function sse(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}
function anthropicSse(events: readonly { type: string }[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function response(
  provider: WireProvider,
  method: WireMethod,
  scenario: WireScenario,
): RecordedResponse {
  const tool = scenario === 'named' || scenario === 'continuation';
  const signed = scenario === 'continuation';
  const text = scenario === 'structured' ? '{"ok":true}' : 'Paris is sunny at 18 C.';
  let body: string;
  if (provider === 'anthropic') {
    const content = tool
      ? [
          ...(signed
            ? [
                {
                  type: 'thinking',
                  thinking: 'Check the weather.',
                  signature: 'wire-anthropic-thought',
                },
              ]
            : []),
          {
            type: 'tool_use',
            id: 'toolu_wire_weather',
            name: 'get_weather',
            input: { city: 'Paris' },
          },
        ]
      : [{ type: 'text', text }];
    const message = {
      id: 'msg_wire',
      type: 'message',
      role: 'assistant',
      model: 'w8-wire-anthropic',
      content,
      stop_reason: tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: anthropicUsage,
    };
    if (method === 'generate') body = JSON.stringify(message);
    else {
      const events: Array<{ type: string } & Record<string, unknown>> = [
        {
          type: 'message_start',
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { ...anthropicUsage, output_tokens: 0 },
          },
        },
      ];
      if (signed)
        events.push(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Check the weather.' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'wire-anthropic-thought' },
          },
          { type: 'content_block_stop', index: 0 },
        );
      const index = signed ? 1 : 0;
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: tool
            ? { type: 'tool_use', id: 'toolu_wire_weather', name: 'get_weather', input: {} }
            : { type: 'text', text: '' },
        },
        ...(tool
          ? [
              {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: '{"city":' },
              },
              {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
              },
            ]
          : [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }]),
        { type: 'content_block_stop', index },
        {
          type: 'message_delta',
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' },
      );
      body = anthropicSse(events);
    }
  } else if (provider === 'gemini') {
    const parts = tool
      ? [
          ...(signed
            ? [
                {
                  text: 'Check the weather.',
                  thought: true,
                  thoughtSignature: 'wire-gemini-thought',
                },
              ]
            : []),
          {
            functionCall: { name: 'get_weather', args: { city: 'Paris' } },
            ...(signed ? { thoughtSignature: 'wire-gemini-call' } : {}),
          },
        ]
      : [{ text }];
    const native = {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: geminiUsage,
    };
    body = method === 'generate' ? JSON.stringify(native) : sse([native]);
  } else {
    const usage = provider === 'deepseek' ? deepseekUsage : openaiUsage;
    const envelope = { id: 'chatcmpl_wire', created: 0, model: `w8-wire-${provider}` };
    const finishReason = tool ? 'tool_calls' : 'stop';
    const call = {
      id: 'call_wire_weather',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    };
    if (method === 'generate')
      body = JSON.stringify({
        ...envelope,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: tool ? null : text,
              ...(tool ? { tool_calls: [call] } : {}),
            },
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
        usage,
      });
    else {
      const chunk = (delta: unknown, finish: string | null) => ({
        ...envelope,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      body =
        sse([
          ...(tool
            ? [
                chunk(
                  {
                    role: 'assistant',
                    tool_calls: [
                      {
                        ...call,
                        index: 0,
                        function: { name: 'get_weather', arguments: '{"city":' },
                      },
                    ],
                  },
                  null,
                ),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, null),
              ]
            : [chunk({ role: 'assistant', content: text }, null)]),
          chunk({}, finishReason),
          { ...envelope, object: 'chat.completion.chunk', choices: [], usage },
        ]) + 'data: [DONE]\n\n';
    }
  }
  return {
    status: 200,
    contentType: method === 'stream' ? 'text/event-stream' : 'application/json',
    body,
  };
}

export function canonicalWireExchange(
  provider: WireProvider,
  method: WireMethod,
  scenario: WireScenario,
): ExpectedExchange {
  const origin =
    provider === 'anthropic'
      ? 'https://api.anthropic.com'
      : provider === 'gemini'
        ? 'https://generativelanguage.googleapis.com'
        : provider === 'deepseek'
          ? 'https://api.deepseek.com'
          : 'https://api.openai.com';
  const path =
    provider === 'anthropic'
      ? '/v1/messages'
      : provider === 'gemini'
        ? `/v1beta/models/w8-wire-gemini:${method === 'stream' ? 'streamGenerateContent' : 'generateContent'}`
        : provider === 'deepseek'
          ? '/chat/completions'
          : '/v1/chat/completions';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider !== 'gemini') headers['accept'] = 'application/json';
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return {
    request: {
      method: 'POST',
      origin,
      path,
      query: provider === 'gemini' && method === 'stream' ? '?alt=sse' : '',
      headers,
      body: { kind: 'json', value: expectedBody(provider, method, scenario) },
    },
    response: response(provider, method, scenario),
  };
}
