import {
  unwiredEffectJournal,
  type AbortSignalLike,
  type Agent,
  type EffectDispatchPort,
} from '@relavium/shared';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../interpolation/provenance.js';
import * as resolver from '../interpolation/resolve.js';
import type { ResolverCapabilities } from '../interpolation/scope.js';
import type { AgentPlanConfig, PlanVertex } from '../run-plan.js';
import { createAgentNodeExecutor, type AgentRunnerDeps } from './agent-runner.js';
import type {
  NodeExecContext,
  NodePreparationContext,
  NodeStreamEvent,
  BudgetDispatchPreparationResult,
  NodeOutcome,
} from './node-executor.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';

const originalResolve = resolver.resolvePublicTemplate;
afterEach(() => vi.restoreAllMocks());
type Route = 'ordinary' | 'budget-preparation';
type Surface = 'chat' | 'generative';
const routes: readonly Route[] = ['ordinary', 'budget-preparation'];
const surfaces: readonly Surface[] = ['chat', 'generative'];
const agent: Agent = {
  id: 'summarizer',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'Summarize.',
  reasoning_effort: 'high',
};
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  if (resolve === undefined || reject === undefined) throw new Error('missing deferred callbacks');
  return { promise, resolve, reject };
}
async function* reply(): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  yield { type: 'text_delta', text: 'ANSWER' };
  yield {
    type: 'stop',
    stopReason: 'stop',
    usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
  };
}
function agentVertex(prompt: string | undefined, surface: Surface): PlanVertex {
  const node: AgentPlanConfig['node'] = {
    id: 'agent',
    type: 'agent',
    agent_ref: 'summarizer',
    ...(prompt === undefined ? {} : { prompt_template: prompt }),
    ...(surface === 'generative' ? { output_modalities: ['image'] } : {}),
  };
  return {
    id: 'agent',
    type: 'agent',
    dependencies: [],
    dependents: [],
    ancestors: [],
    inputSites: [],
    config: { kind: 'agent', node, resolvedAgent: agent },
  };
}
function preparationContextOf(ctx: NodeExecContext): NodePreparationContext {
  return {
    vertex: ctx.vertex,
    runOutputs: ctx.runOutputs,
    inputs: ctx.inputs,
    ctx: ctx.ctx,
    secretInputNames: ctx.secretInputNames,
    toolPolicy: ctx.toolPolicy,
    signal: ctx.signal,
  };
}
function harness(
  prompt: string | undefined,
  surface: Surface,
  readFile?: ResolverCapabilities['readFile'],
) {
  const controller = new AbortController();
  const requests: LlmRequest[] = [];
  const stream = vi.fn((request: LlmRequest) => {
    requests.push(request);
    return reply();
  });
  const generate = vi.fn<LlmProvider['generate']>(() => {
    throw new Error('unexpected chat generate');
  });
  const generateMedia = vi.fn<NonNullable<LlmProvider['generateMedia']>>(() =>
    Promise.resolve({
      media: { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aW1n' } },
    }),
  );
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: {
      tools: false,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: true,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image']],
        ...(surface === 'generative' ? { surface: 'generative' } : {}),
      },
    },
    stream,
    generate,
    generateMedia,
  };
  const keyFor = vi.fn(() => 'offline-fixture-key');
  const preEgress = vi.fn<NonNullable<AgentRunnerDeps['preEgress']>>(() => undefined);
  const notice = vi.fn<NonNullable<AgentRunnerDeps['onEffortWithheld']>>();
  const dispatch = vi.fn<AgentRunnerDeps['registry']['dispatch']>(() => {
    throw new Error('unexpected tool dispatch');
  });
  const port = unwiredEffectJournal();
  const prepare = vi.fn<EffectDispatchPort['prepare']>((...args) => port.prepare(...args));
  const settle = vi.fn<EffectDispatchPort['settle']>((...args) => port.settle(...args));
  const discard = vi.fn<EffectDispatchPort['discard']>((...args) => port.discard(...args));
  const events: NodeStreamEvent[] = [];
  const ctx: NodeExecContext = {
    vertex: agentVertex(prompt, surface),
    signal: controller.signal,
    runOutputs: new Map(),
    inputs: { path: 'prompt.txt', secret: 'trusted-secret-canary' },
    ctx: createWorkflowContextProjection({
      values: { public: 'clean' },
      deniedKeys: ['private'],
      orderedKeys: ['private', 'public'],
    }),
    secretInputNames: ownSecretInputNames(['secret']).secretInputNames,
    toolPolicy: {},
    emit: (event) => events.push(event),
    attemptNumber: 1,
    preEgress,
    effects: { prepare, settle, discard },
  };
  const deps: AgentRunnerDeps = {
    resolveProvider: () => provider,
    resolveMediaSurface: () => surface,
    keyFor,
    preEgress,
    onEffortWithheld: notice,
    resolveEffortTiers: () => undefined,
    sleep: () => Promise.resolve(),
    tools: [],
    registry: { has: () => false, list: () => [], dispatch },
    ...(readFile === undefined ? {} : { resolverCapabilities: { readFile } }),
  };
  const executor = createDispatchingNodeExecutor({ agent: createAgentNodeExecutor(deps) });
  async function enter(route: Route): Promise<NodeOutcome | BudgetDispatchPreparationResult> {
    if (route === 'ordinary') return executor.execute(ctx);
    if (executor.prepareBudgetDispatch === undefined)
      throw new Error('dispatcher dropped budget preparation');
    return executor.prepareBudgetDispatch(preparationContextOf(ctx));
  }
  function assertNoEgress(route: Route): void {
    for (const spy of [stream, generate, generateMedia, keyFor, preEgress, notice, dispatch])
      expect(
        spy,
        'prompt refusal precedes credentials, provider egress, notices and dispatch',
      ).not.toHaveBeenCalled();
    if (route === 'ordinary')
      for (const spy of [prepare, settle, discard])
        expect(
          spy,
          'ordinary prompt refusal precedes real effect-port entry',
        ).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  }
  return {
    controller,
    ctx,
    executor,
    requests,
    stream,
    generateMedia,
    keyFor,
    notice,
    enter,
    assertNoEgress,
  };
}
function assertCancelled(outcome: NodeOutcome | BudgetDispatchPreparationResult): void {
  expect(outcome.kind, 'cancelled prompt never returns a prepared or completed dispatch').toBe(
    'failed',
  );
  if (outcome.kind !== 'failed') throw new Error('expected failed prompt outcome');
  expect(outcome.error).toMatchObject({ code: 'cancelled', retryable: false });
  expect(outcome.error.message).not.toContain('HOST-READ-CANARY');
}

for (const route of routes)
  for (const surface of surfaces)
    describe(`agent prompt cancellation #76: ${route}/${surface}`, () => {
      it('forwards the identical node signal to prompt read_file and admits a live dispatch', async () => {
        const entered = deferred<void>();
        const held = deferred<string>();
        const reads: { path: string; signal: AbortSignalLike | undefined }[] = [];
        const h = harness('{{inputs.path | read_file}}', surface, (path, signal) => {
          reads.push({ path, signal });
          entered.resolve();
          return held.promise;
        });
        const pending = h.enter(route);
        await entered.promise;
        expect
          .soft(reads, 'read_file receives identical node signal')
          .toEqual([{ path: 'prompt.txt', signal: h.ctx.signal }]);
        expect.soft(reads[0]?.signal).toBe(h.ctx.signal);
        held.resolve('resolved prompt');
        const outcome = await pending;
        if (route === 'budget-preparation') {
          expect(outcome.kind).toBe('prepared');
          if (outcome.kind !== 'prepared') throw new Error('live budget preparation refused');
          h.assertNoEgress(route);
          expect(outcome.preparation.quote({ strictCostCap: false }).kind).toBe('quoted');
          expect(await outcome.preparation.execute(h.ctx)).toMatchObject({ kind: 'completed' });
        } else expect(outcome).toMatchObject({ kind: 'completed' });
        expect(surface === 'chat' ? h.stream : h.generateMedia).toHaveBeenCalledOnce();
        expect(h.keyFor).toHaveBeenCalledOnce();
        if (surface === 'chat')
          expect(h.requests[0]?.messages).toMatchObject([
            { content: [{ text: 'resolved prompt' }] },
          ]);
      });

      it.each(['fulfill', 'reject'] as const)(
        'noncooperative prompt read %s after abort remains cancelled before admission',
        async (settlement) => {
          const entered = deferred<void>();
          const held = deferred<string>();
          const h = harness('{{inputs.path | read_file}}', surface, () => {
            entered.resolve();
            return held.promise;
          });
          const pending = h.enter(route);
          await entered.promise;
          h.controller.abort();
          if (settlement === 'fulfill') held.resolve('late host text');
          else held.reject(new Error('HOST-READ-CANARY /private/path'));
          const outcome = await pending;
          h.assertNoEgress(route);
          assertCancelled(outcome);
        },
      );

      it('live prompt read rejection remains fatal validation', async () => {
        const h = harness('{{inputs.path | read_file}}', surface, () =>
          Promise.reject(new Error('live unavailable read')),
        );
        expect(await h.enter(route)).toMatchObject({
          kind: 'failed',
          error: { code: 'validation', retryable: false },
        });
        h.assertNoEgress(route);
      });

      it.each(['literal', '', undefined])(
        'already aborted literal/empty/omitted prompt refuses before request preparation: %j',
        async (prompt) => {
          const h = harness(prompt, surface);
          h.controller.abort();
          const outcome = await h.enter(route);
          h.assertNoEgress(route);
          assertCancelled(outcome);
        },
      );

      it.each(['{{inputs.path | read_file}}', 'literal', '', undefined])(
        'abort after real public resolver settles wins before continuation: %j',
        async (prompt) => {
          const trace: string[] = [];
          const h = harness(prompt, surface, () => Promise.resolve('real read output'));
          vi.spyOn(resolver, 'resolvePublicTemplate').mockImplementation(async (...args) => {
            const text = await originalResolve(...args);
            trace.push('resolver-settled');
            h.controller.abort();
            trace.push('abort-requested');
            return text;
          });
          const outcome = await h.enter(route);
          trace.push('handler-outcome');
          expect(trace).toEqual(['resolver-settled', 'abort-requested', 'handler-outcome']);
          h.assertNoEgress(route);
          assertCancelled(outcome);
        },
      );

      it.each([
        '{{inputs.secret | default("fallback") | read_file}}',
        '{{ctx.private | default("fallback") | read_file}}',
      ])('secret reference refusal still precedes reads and egress: %s', async (prompt) => {
        const readFile = vi.fn(() => Promise.resolve('unreachable'));
        const h = harness(prompt, surface, readFile);
        expect(await h.enter(route)).toMatchObject({
          kind: 'failed',
          error: { code: 'validation', retryable: false },
        });
        expect(readFile).not.toHaveBeenCalled();
        h.assertNoEgress(route);
      });
    });
