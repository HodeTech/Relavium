import { describe, expect, it } from 'vitest';
import {
  ownLlmRequest,
  ownedRequestSource,
  selectOwnedRequest,
  withOwnedRequestSignal,
  mutableOwnedRequest,
  withoutOwnedRequestEffort,
  deriveOwnedRequestMessages,
  outputCapPlanForRequest,
  InvalidOutputCapPlanError,
} from './output-cap.js';
import { FallbackChain } from './fallback-chain.js';
import type { AttemptRecord } from './fallback-chain.js';
import type { LlmProvider } from './types.js';

describe('unselected owned request source', () => {
  it('preserves construction and captured plans without granting selected cap or transformation authority', () => {
    let captures = 0;
    const candidates = [
      { model: 'a', provider: 'openai', endpoint: 'custom' },
      { model: 'b', provider: 'gemini', endpoint: 'custom' },
    ] as const;
    const owner = ownLlmRequest(
      {
        model: 'a',
        messages: [],
        providerOptions: {
          max_completion_tokens: {
            toJSON: () => {
              captures += 1;
              return 70;
            },
          },
          maxOutputTokens: 90,
        },
      },
      candidates,
    );
    const source = ownedRequestSource(owner);
    expect(Object.isFrozen(source)).toBe(true);
    const controller = new AbortController();
    const signaled = withOwnedRequestSignal(source, controller.signal);
    for (const request of [source, signaled]) {
      expect(request.preparedOutputCaps).toBeUndefined();
      expect(() => outputCapPlanForRequest(request, 'openai', 'custom')).toThrow(
        InvalidOutputCapPlanError,
      );
      expect(() => mutableOwnedRequest(request)).toThrow(InvalidOutputCapPlanError);
      expect(() => withoutOwnedRequestEffort(request)).toThrow(InvalidOutputCapPlanError);
      expect(() =>
        deriveOwnedRequestMessages(request, { route: 'reasoning', messages: [] }),
      ).toThrow(InvalidOutputCapPlanError);
      expect(() => deriveOwnedRequestMessages(request, { route: 'media', messages: [] })).toThrow(
        InvalidOutputCapPlanError,
      );
      for (const candidate of candidates) {
        const selected = selectOwnedRequest(request, candidate);
        expect(selected.plan).toBe(selectOwnedRequest(owner, candidate).plan);
        expect(
          outputCapPlanForRequest(selected.request, candidate.provider, candidate.endpoint),
        ).toBe(selected.plan);
        expect(() => mutableOwnedRequest(selected.request)).not.toThrow();
      }
    }
    controller.abort();
    expect(signaled.signal?.aborted).toBe(true);
    expect(captures).toBe(1);
    expect(() => ownedRequestSource({ ...source })).toThrow(InvalidOutputCapPlanError);
  });

  it.each(['generate', 'stream'] as const)(
    '%s retains all-unsupported skips without selecting or recapturing failed native caps',
    async (path) => {
      let effects = 0;
      let captures = 0;
      const provider = (id: 'openai' | 'anthropic'): LlmProvider => ({
        id,
        customEndpoint: true,
        supports: {
          tools: false,
          streaming: true,
          parallelToolCalls: true,
          vision: false,
          promptCache: false,
          reasoning: false,
          media: {
            input: { image: false, audio: false, video: false, document: false },
            outputCombinations: [],
          },
        },
        generate: () => {
          effects += 1;
          throw new Error('unexpected dispatch');
        },
        stream: () => {
          effects += 1;
          throw new Error('unexpected dispatch');
        },
      });
      const entries = [
        { provider: provider('openai'), model: 'a', maxAttempts: 1 },
        { provider: provider('anthropic'), model: 'b', maxAttempts: 1 },
      ];
      const candidates = entries.map((entry) => ({
        model: entry.model,
        provider: entry.provider.id,
        endpoint: 'custom' as const,
      }));
      const owner = ownLlmRequest(
        {
          model: 'a',
          messages: [],
          tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
          providerOptions: {
            max_completion_tokens: {
              toJSON: () => {
                captures += 1;
                throw new Error('private native failure');
              },
            },
          },
        },
        candidates,
      );
      const source = ownedRequestSource(owner);
      const attempts: AttemptRecord[] = [];
      const chain = new FallbackChain(entries, {
        keyFor: () => {
          effects += 1;
          return 'offline';
        },
        sleep: () => Promise.resolve(),
        preAttempt: () => {
          effects += 1;
        },
        onAttempt: (record) => {
          attempts.push(record);
        },
      });
      const expected =
        "fallback chain exhausted: no provider could serve the request (provider cannot serve the request: 'tools' capability not supported)";
      if (path === 'generate')
        await expect(chain.generate(source)).rejects.toMatchObject({ message: expected });
      else {
        const chunks = [];
        for await (const chunk of chain.stream(source)) chunks.push(chunk);
        expect(chunks).toMatchObject([
          { type: 'error', error: { kind: 'bad_request', message: expected } },
        ]);
      }
      expect(attempts.map((record) => record.outcome)).toEqual(['skipped', 'skipped']);
      expect(captures).toBe(2);
      expect(effects).toBe(0);
      for (const candidate of candidates)
        expect(() => selectOwnedRequest(source, candidate)).toThrow(InvalidOutputCapPlanError);
    },
  );
});
