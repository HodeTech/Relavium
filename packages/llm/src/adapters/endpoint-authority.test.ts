import { afterEach, describe, expect, it, vi } from 'vitest';

import { FallbackChain, type AttemptRecord, type PreAttemptInfo } from '../fallback-chain.js';
import { createOpenAiAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createGeminiAdapter } from './gemini.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('factory route authority survives SDK ambient overrides (ADR-0101)', () => {
  for (const provider of ['openai', 'deepseek', 'anthropic', 'gemini'] as const) {
    for (const path of ['generate', 'stream'] as const) {
      it(`${provider} ${path}: pins the official endpoint and Gemini backend before classifying evidence`, async () => {
        const gateway = 'https://untrusted-environment.example/v1';
        vi.stubEnv('OPENAI_BASE_URL', gateway);
        vi.stubEnv('ANTHROPIC_BASE_URL', gateway);
        vi.stubEnv('GOOGLE_GEMINI_BASE_URL', gateway);
        vi.stubEnv('GOOGLE_VERTEX_BASE_URL', gateway);
        vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
        const urls: string[] = [];
        const fetch = (input: unknown): Promise<Response> => {
          urls.push(input instanceof Request ? input.url : String(input));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'bad_request',
                  type: 'invalid_request_error',
                  message: 'offline refusal',
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            ),
          );
        };
        vi.stubGlobal('fetch', fetch);
        const adapter =
          provider === 'anthropic'
            ? createAnthropicAdapter({ fetch })
            : provider === 'gemini'
              ? createGeminiAdapter()
              : createOpenAiAdapter({ providerId: provider, fetch });
        const model =
          provider === 'anthropic'
            ? 'claude-opus-4-8'
            : provider === 'gemini'
              ? 'gemini-2.5-pro'
              : 'gpt-5.4-pro';
        const records: AttemptRecord[] = [];
        const infos: PreAttemptInfo[] = [];
        const chain = new FallbackChain([{ provider: adapter, model, maxAttempts: 1 }], {
          keyFor: () => 'synthetic-test-key',
          sleep: () => Promise.resolve(),
          preAttempt: (info) => {
            infos.push(info);
          },
          onAttempt: (record) => {
            records.push(record);
          },
        });
        const request = {
          model,
          messages: [
            {
              role: 'user' as const,
              content: [{ type: 'text' as const, text: 'offline request' }],
            },
          ],
        };
        if (path === 'generate') await expect(chain.generate(request)).rejects.toBeDefined();
        else for await (const chunk of chain.stream(request)) expect(chunk.type).toBe('error');
        expect(urls).toHaveLength(1);
        const host =
          provider === 'openai'
            ? 'api.openai.com'
            : provider === 'deepseek'
              ? 'api.deepseek.com'
              : provider === 'anthropic'
                ? 'api.anthropic.com'
                : 'generativelanguage.googleapis.com';
        expect(new URL(urls[0] ?? '').hostname).toBe(host);
        expect(infos).toHaveLength(1);
        expect(infos[0]?.endpoint).toBe('official');
        expect(records).toHaveLength(1);
        expect(records[0]?.customEndpoint).toBe(false);
        expect(records[0]?.contentReceived).toBe(false);
      });
    }
  }
});
