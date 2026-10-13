import { createClient, createProviderStore, llmProviders, runMigrations } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { vi } from 'vitest';

import { keychainAccount, type KeychainStore } from '../../secrets/keychain.js';

// Deliberately opaque: neither names nor values rely on a token-shape redactor.
export const LEGACY_HEADERS = {
  'x-wave7-legacy-opaque': 'orchid-pebble-custody-742',
  'x-wave7-benign-mode': 'ordinary-literal-619',
};
export const LEGACY_HEADERS_JSON = JSON.stringify(LEGACY_HEADERS);
export const SYNTHETIC_PROVIDER_KEY = 'offline-wave7-provider-key-483';

/** Genuine historical SQLite input, rather than a bypass in ProviderStore.upsert. */
export function seedLegacyProvider(
  provider: ProviderId,
  baseUrl: string,
  rawHeaders: string = LEGACY_HEADERS_JSON,
) {
  const client = createClient(':memory:');
  try {
    runMigrations(client.db);
    client.db
      .insert(llmProviders)
      .values({
        id: '00000000-0000-4000-8000-000000000708',
        name: provider,
        displayName: `Offline ${provider}`,
        baseUrl,
        apiKeyKeychainRef: keychainAccount(provider),
        defaultHeaders: rawHeaders,
        createdAt: 1_798_848_000_000,
        updatedAt: 1_798_848_000_000,
      })
      .run();
    return {
      client,
      store: createProviderStore(client.db, {
        uuid: () => '00000000-0000-4000-8000-000000000709',
        now: () => 1_798_848_001_000,
      }),
    };
  } catch (error) {
    client.sqlite.close();
    throw error;
  }
}

/** SDKs read their own ambient credentials/headers independently of the resolver's literal env {}. */
export function isolateSdkEnvironment(): void {
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_ADMIN_KEY',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'OPENAI_WEBHOOK_SECRET',
    'OPENAI_CUSTOM_HEADERS',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_WEBHOOK_SIGNING_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_BASE_URL',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_ENTERPRISE',
    'GOOGLE_VERTEX_BASE_URL',
    'GOOGLE_GEMINI_BASE_URL',
    'GEMINI_NEXT_GEN_API_BASE_URL',
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('OPENAI_LOG', 'off');
  vi.stubEnv('ANTHROPIC_LOG', 'off');
  vi.stubEnv('GEMINI_NEXT_GEN_API_LOG', 'off');
}

/** In-memory only; unexpected accounts and writes fail rather than reaching a native accessor. */
export function syntheticKeychain(
  provider: ProviderId,
  key: string | null = SYNTHETIC_PROVIDER_KEY,
): KeychainStore {
  return {
    get(account) {
      if (account !== keychainAccount(provider)) throw new Error('unexpected fixture key account');
      return key;
    },
    set() {
      throw new Error('unexpected fixture key write');
    },
    delete() {
      throw new Error('unexpected fixture key deletion');
    },
  };
}

const OFFLINE_USAGE = {
  prompt_tokens: 1,
  completion_tokens: 1,
  total_tokens: 2,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};

export function offlineOpenAiReply(model: string): Response {
  return Response.json({
    id: 'offline-completion',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: 'offline' }, finish_reason: 'stop' },
    ],
    usage: OFFLINE_USAGE,
  });
}

export function offlineOpenAiStream(model: string): Response {
  const frames = [
    {
      id: 'offline-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'offline' }, finish_reason: null },
      ],
    },
    {
      id: 'offline-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: OFFLINE_USAGE,
    },
  ];
  return new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

export function offlineOpenAiRefusal(): Response {
  return Response.json(
    { error: { type: 'invalid_request_error', code: 'bad_request', message: 'offline refusal' } },
    { status: 400 },
  );
}
