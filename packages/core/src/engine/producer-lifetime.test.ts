import { expect, it } from 'vitest';
import { unwiredEffectJournal, type ContentPart, type RunEvent } from '@relavium/shared';
import type {
  LlmInvocationOptions,
  LlmProvider,
  LlmResult,
  MediaGenResult,
  MediaJobStatus,
} from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { LlmProviderError, makeLlmError } from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor, type AgentRunnerDeps } from './agent-runner.js';
import { captureAgentTurnOutcome, type AgentTurnParams } from './agent-turn.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import type { NodeExecContext, NodeStreamEvent, NodeReceiptContext } from './node-executor.js';
import type { BudgetAdmission } from './budget-governor.js';

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('producer transition did not complete');
}
function timer() {
  const callbacks = new Set<() => void>();
  return {
    set: (_ms: number, callback: () => void): (() => void) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    fire: () => {
      for (const callback of [...callbacks]) {
        callbacks.delete(callback);
        callback();
      }
    },
  };
}
const image: Extract<ContentPart, { type: 'media' }> = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'base64', data: 'AQ==' },
};
const generated: LlmResult = {
  content: [image],
  stopReason: 'stop',
  usage: { inputTokens: 3, outputTokens: 2 },
};
function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'openai',
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image']],
      },
    },
    generate: () => Promise.resolve(generated),
    stream: async function* () {
      await Promise.resolve();
      yield { type: 'stop', stopReason: 'stop', usage: generated.usage };
    },
    ...overrides,
  };
}
const registry = {
  has: () => false,
  list: () => [],
  dispatch: () => {
    throw new Error('unexpected tool dispatch');
  },
};
function deps(
  p: LlmProvider,
  clock: ReturnType<typeof timer>,
  extra: Partial<AgentRunnerDeps> = {},
): AgentRunnerDeps {
  return {
    resolveProvider: () => p,
    registry,
    tools: [],
    keyFor: () => 'offline-placeholder',
    sleep: () => Promise.resolve(),
    newAbortController: () => new AbortController(),
    setTimer: clock.set,
    attemptTimeoutMs: 5,
    ...extra,
  };
}
function workflow(media: boolean) {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'producer-lifetime',
        agents: [{ id: 'agent', provider: 'openai', model: 'gpt-4o', system_prompt: 's' }],
        nodes: [
          {
            id: 'work',
            type: 'agent',
            agent_ref: 'agent',
            prompt_template: 'offline',
            retry: { max: 1, backoff: 'linear' },
            ...(media ? { output_modalities: ['image'] } : {}),
          },
        ],
        edges: [],
      },
    }),
  );
}
function start(p: LlmProvider, media: boolean, extra: Partial<AgentRunnerDeps> = {}) {
  const clock = timer();
  let pins = 0;
  const host = createInMemoryHost({
    mediaStore: {
      put: () => {
        pins++;
        return Promise.resolve(`media://sha256-${'1'.repeat(64)}`);
      },
      get: () => Promise.resolve(new Uint8Array([1])),
      readRange: () => Promise.reject(new Error('unexpected range')),
      resolveForEgress: () => Promise.reject(new Error('unexpected media egress')),
    },
  });
  const engine = new WorkflowEngine({
    host,
    executor: createAgentNodeExecutor(deps(p, clock, extra)),
  });
  const handle = engine.start({ workflow: workflow(media) });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  return { clock, host, handle, events, drained, pins: () => pins };
}

for (const separateEndpoint of [false, true])
  it(`shipping runner retains ${separateEndpoint ? 'generateMedia' : 'inline generate'} after bounded failure and does no late delivery`, async () => {
    const raw = latch<LlmResult>();
    const mediaRaw = latch<MediaGenResult>();
    const entered = latch<void>();
    let calls = 0;
    let invocation: LlmInvocationOptions | undefined;
    const p = provider({
      generate: (_request, _key, options) => {
        invocation = options;
        calls++;
        entered.resolve();
        return raw.promise;
      },
      generateMedia: (_request, _key, options) => {
        invocation = options;
        calls++;
        entered.resolve();
        return mediaRaw.promise;
      },
    });
    const run = start(p, true, {
      resolveMediaSurface: () => (separateEndpoint ? 'generative' : 'chat'),
    });
    try {
      await entered.promise;
      const fence = await run.host.runLeases.read(run.handle.runId);
      expect(fence).toBeDefined();
      run.clock.fire();
      await run.drained;
      expect(run.events.at(-1)?.type).toBe('run:failed');
      if (invocation === undefined) throw new Error('custom invocation authority required');
      let forbiddenEntries = 0;
      expect(() =>
        invocation?.retainWork(() => {
          forbiddenEntries++;
          return Promise.resolve();
        }),
      ).toThrow();
      expect(forbiddenEntries).toBe(0);
      expect(calls).toBe(1);
      expect(await run.host.runLeases.read(run.handle.runId)).toEqual(fence);
      expect(run.host.livenessCount()).toBe(1);
      expect(run.pins()).toBe(0);
      const authoritativeCosts = run.events.filter((e) => e.type.startsWith('cost:')).length;
      if (separateEndpoint) mediaRaw.resolve({ media: image, raw: {} });
      else raw.resolve(generated);
      await until(async () => (await run.host.runLeases.read(run.handle.runId)) === undefined);
      expect(run.host.livenessCount()).toBe(0);
      expect(run.pins()).toBe(0);
      expect(calls).toBe(1);
      expect(run.events.filter((e) => e.type.startsWith('cost:'))).toHaveLength(authoritativeCosts);
      expect(run.events.at(-1)?.type).toBe('run:failed');
    } finally {
      raw.resolve(generated);
      mediaRaw.resolve({ media: image, raw: {} });
      run.clock.fire();
      await run.drained;
      await until(async () => (await run.host.runLeases.read(run.handle.runId)) === undefined);
    }
  });

it('an installed OpenAI SDK pending body read keeps its exact fence after bounded stream failure', async () => {
  const entered = latch<void>();
  const bodyRead = latch<void>();
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let calls = 0;
  const p = createOpenAiAdapter({
    maxRetries: 0,
    fetch: () => {
      calls++;
      entered.resolve();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start: (c) => {
                body = c;
              },
              pull: () => {
                bodyRead.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    },
  });
  const run = start(p, false);
  try {
    await entered.promise;
    // This zero-high-water stream reports actual SDK reader demand, without a timing guess.
    await bodyRead.promise;
    const fence = await run.host.runLeases.read(run.handle.runId);
    expect(fence).toBeDefined();
    run.clock.fire();
    await run.drained;
    expect(run.events.at(-1)?.type).toBe('run:failed');
    expect(calls).toBe(1);
    expect(await run.host.runLeases.read(run.handle.runId)).toEqual(fence);
    expect(run.host.livenessCount()).toBe(1);
    if (body === undefined) throw new Error('SDK response body was not installed');
    body.close();
    body = undefined;
    await until(async () => (await run.host.runLeases.read(run.handle.runId)) === undefined);
    expect(run.host.livenessCount()).toBe(0);
    expect(calls).toBe(1);
  } finally {
    body?.close();
    run.clock.fire();
    await run.drained;
    await until(async () => (await run.host.runLeases.read(run.handle.runId)) === undefined);
  }
});

function turn(p: LlmProvider): AgentTurnParams {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
    planEntries: [{ provider: p, model: 'gpt-4o', maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'offline-placeholder', sleep: () => Promise.resolve() },
    outputModalities: ['image'],
    nodeId: 'work',
    signal: new AbortController().signal,
    emit: () => undefined,
    registry,
    dispatchContext: {
      nodeId: 'work',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: { maxToolTurns: 1, maxToolCorrections: 0 },
  };
}
function throwHostFailure(original: unknown): never {
  throw original;
}
it('turn capture retains host entry identity/provenance without provider engagement', async () => {
  const original = Object.freeze({ marker: 'host-entry' });
  let calls = 0;
  const p = provider({
    generate: () => {
      calls++;
      return Promise.resolve(generated);
    },
  });
  const outcome = await captureAgentTurnOutcome({
    ...turn(p),
    retainWork: () => throwHostFailure(original),
  });
  expect(outcome).toMatchObject({
    kind: 'failed',
    failureOrigin: 'observer',
    engaged: false,
    usage: { input: 0, output: 0 },
  });
  if (outcome.kind !== 'failed') throw new Error('expected host-entry refusal');
  expect(outcome.error).toBe(original);
  expect(calls).toBe(0);
});

it('generative entry refusal releases proven pre-egress admission and escapes the original host cause', async () => {
  const original = Object.freeze({ marker: 'media-host-entry' });
  let calls = 0;
  let releases = 0;
  let conservative = 0;
  const admission: BudgetAdmission = {
    settle: () => undefined,
    settleAtReservedEstimate: () => {
      conservative++;
    },
    release: () => {
      releases++;
    },
  };
  const p = provider({
    generateMedia: () => {
      calls++;
      return Promise.resolve({ media: image, raw: {} });
    },
  });
  const wf = workflow(true);
  const host = createInMemoryHost();
  let context: NodeExecContext | undefined;
  const capture = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        context = ctx;
        return Promise.resolve({ kind: 'completed', output: '' });
      },
    },
  });
  const handle = capture.start({ workflow: wf });
  const initialEvents: RunEvent[] = [];
  for await (const event of handle.events) initialEvents.push(event);
  expect(initialEvents.at(-1)?.type).toBe('run:completed');
  if (context === undefined) throw new Error('missing actual context');
  const events: NodeStreamEvent[] = [];
  const fresh = {
    ...context,
    signal: new AbortController().signal,
    emit: (event: NodeStreamEvent) => events.push(event),
    preEgress: () => admission,
    continueReceipt: () => throwHostFailure(original),
  };
  await expect(
    createAgentNodeExecutor(deps(p, timer(), { resolveMediaSurface: () => 'generative' })).execute(
      fresh,
    ),
  ).rejects.toBe(original);
  expect(calls).toBe(0);
  expect(releases).toBe(1);
  expect(conservative).toBe(0);
  expect(events.some((e) => e.type.startsWith('cost:'))).toBe(false);
});

for (const held of ['raw poll', 'transferred child'] as const)
  it(`media poll keeps its original lease and heartbeat after cancel while ${held} remains owed`, async () => {
    const raw = latch<import('@relavium/llm').MediaJobStatus>();
    const child = latch<void>();
    const entered = latch<void>();
    let polls = 0;
    let pins = 0;
    let invocation: LlmInvocationOptions | undefined;
    const p = provider({
      generateMedia: () => Promise.resolve({ jobId: 'local-test-job', raw: {} }),
      pollMediaJob: (_id, _key, _signal, options) => {
        polls += 1;
        if (options === undefined) throw new Error('poll lost invocation lifetime authority');
        invocation = options;
        void options.retainWork(() => child.promise);
        entered.resolve();
        return raw.promise;
      },
    });
    const host = createInMemoryHost({
      mediaStore: {
        put: () => {
          pins += 1;
          return Promise.resolve(`media://sha256-${'1'.repeat(64)}`);
        },
        get: () => Promise.resolve(new Uint8Array([1])),
        readRange: () => Promise.reject(new Error('unexpected range')),
        resolveForEgress: () => Promise.reject(new Error('unexpected media egress')),
      },
    });
    const clock = timer();
    const executor = createAgentNodeExecutor(
      deps(p, clock, { resolveMediaSurface: () => 'generative' }),
    );
    const handle = new WorkflowEngine({ host, executor }).start({ workflow: workflow(true) });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await until(() => events.some((event) => event.type === 'run:paused'));
      host.fireTimers();
      await entered.promise;
      const fence = await host.runLeases.read(handle.runId);
      expect(fence).toBeDefined();
      handle.cancel();
      if (invocation === undefined) throw new Error('poll invocation authority required');
      let forbiddenEntries = 0;
      expect(() =>
        invocation?.retainWork(() => {
          forbiddenEntries++;
          return Promise.resolve();
        }),
      ).toThrow();
      expect(forbiddenEntries).toBe(0);
      host.fireTimers();
      await drained;
      expect(events.at(-1)?.type).toBe('run:cancelled');
      expect(await host.runLeases.read(handle.runId)).toEqual(fence);
      expect(host.livenessCount()).toBe(1);
      const costs = events.filter((event) => event.type.startsWith('cost:')).length;
      if (held === 'raw poll') child.resolve();
      else raw.resolve({ state: 'pending' });
      for (let n = 0; n < 20; n += 1) await Promise.resolve();
      expect(await host.runLeases.read(handle.runId)).toEqual(fence);
      expect(host.livenessCount()).toBe(1);
      child.resolve();
      raw.resolve({ state: 'done', media: image });
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.livenessCount()).toBe(0);
      expect(polls).toBe(1);
      expect(pins).toBe(0);
      expect(events.filter((event) => event.type.startsWith('cost:'))).toHaveLength(costs);
    } finally {
      child.resolve();
      raw.resolve({ state: 'pending' });
      handle.cancel();
      host.fireTimers();
      clock.fire();
      await drained;
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
    }
  });

for (const mode of ['generateMedia', 'pollMediaJob'] as const)
  for (const cancel of [false, true])
    it(`${mode} rechecks cancellation after invocation transfer and refunds unused admission: ${cancel}`, async () => {
      const abort = new AbortController();
      const captured: Promise<unknown>[] = [];
      let entries = 0,
        calls = 0,
        releases = 0,
        conservative = 0;
      const admission: BudgetAdmission = {
        settle: () => undefined,
        settleAtReservedEstimate: () => {
          conservative++;
        },
        release: () => {
          releases++;
        },
      };
      const p = provider({
        generateMedia: () => {
          calls++;
          throw new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'auth', message: 'offline refused provider' }),
          );
        },
        pollMediaJob: () => {
          calls++;
          return Promise.resolve({ state: 'pending' });
        },
      });
      const runner = createAgentNodeExecutor({
        resolveProvider: () => p,
        keyFor: () => 'offline-placeholder',
        sleep: () => Promise.resolve(),
        tools: [],
        registry,
        resolveMediaSurface: () => 'generative',
      });
      if (mode === 'pollMediaJob') {
        if (runner.pollMediaJob === undefined) throw new Error('missing actual poll');
        const outcome = await runner.pollMediaJob(
          {
            jobId: 'offline-job',
            provider: 'openai',
            model: 'gpt-4o',
            modality: 'image',
            units: 1,
          },
          abort.signal,
          {
            retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
              entries++;
              if (cancel) abort.abort();
              const raw = factory();
              captured.push(raw);
              return raw;
            },
          },
        );
        expect(outcome).toMatchObject(
          cancel ? { state: 'failed', error: { kind: 'cancelled' } } : { state: 'pending' },
        );
      } else {
        const host = createInMemoryHost();
        const handle = new WorkflowEngine({
          host,
          executor: {
            execute: async (ctx) => {
              const retain = ctx.continueReceipt;
              if (retain === undefined) throw new Error('missing actual receipt owner');
              const outcome = await runner.execute({
                ...ctx,
                signal: abort.signal,
                preEgress: () => admission,
                continueReceipt: <T>(
                  factory: (receipt: NodeReceiptContext) => Promise<T>,
                ): Promise<T> => {
                  entries++;
                  if (entries === 2 && cancel) abort.abort();
                  const raw = retain(factory);
                  captured.push(raw);
                  return raw;
                },
              });
              expect(outcome).toMatchObject({
                kind: 'failed',
                error: { code: cancel ? 'cancelled' : 'provider_auth' },
              });
              return outcome;
            },
          },
        }).start({ workflow: workflow(true) });
        const events: RunEvent[] = [];
        for await (const event of handle.events) events.push(event);
        expect((await handle.depart()).kind).toBe('closed');
        expect(events.at(-1)).toMatchObject({
          type: 'run:failed',
          error: { code: cancel ? 'cancelled' : 'provider_auth' },
        });
        expect(releases).toBe(cancel ? 1 : 0);
        expect(conservative > 0).toBe(!cancel);
        expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
        expect(await host.runLeases.read(handle.runId)).toBeUndefined();
      }
      await Promise.allSettled(captured);
      expect(calls).toBe(cancel ? 0 : 1);
    });

for (const state of ['pending', 'done', 'failed'] as const)
  for (const cleanup of ['live', 'mutate', 'throw'] as const)
    it(`poll owns ${state} before invocation cleanup: ${cleanup}`, async () => {
      const failure = new Error('private cleanup fault');
      const diagnostic = {
        provider: 'openai' as const,
        kind: 'auth' as const,
        message: 'original refusal',
        retryable: false,
      };
      const data = { kind: 'base64' as const, data: 'AQ==' };
      const status: MediaJobStatus =
        state === 'done'
          ? { state, media: { type: 'media', mimeType: 'image/png', source: data } }
          : state === 'failed'
            ? { state, error: diagnostic }
            : { state, progress: 0.25 };
      let removed = 0;
      const signal = {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => {
          removed++;
          if (cleanup === 'throw') throw failure;
          if (cleanup === 'mutate') {
            diagnostic.message = 'private mutation';
            data.data = 'Ag==';
            if (status.state === 'pending') status.progress = 0.75;
          }
        },
      };
      const retained: Promise<unknown>[] = [];
      const runner = createAgentNodeExecutor({
        resolveProvider: () => provider({ pollMediaJob: () => Promise.resolve(status) }),
        registry,
        tools: [],
        keyFor: () => 'offline-placeholder',
        sleep: () => Promise.resolve(),
      });
      if (runner.pollMediaJob === undefined) throw new Error('missing actual poll');
      const operation = runner.pollMediaJob(
        { jobId: 'offline-job', provider: 'openai', model: 'gpt-4o', modality: 'image', units: 1 },
        signal,
        {
          retainWork: (factory) => {
            const raw = factory();
            retained.push(raw);
            return raw;
          },
        },
      );
      if (cleanup === 'throw' && state !== 'failed') await expect(operation).rejects.toBe(failure);
      else {
        const outcome = await operation;
        expect(outcome).toMatchObject(
          state === 'done'
            ? { state, media: { source: { data: 'AQ==' } } }
            : state === 'failed'
              ? { state, error: { kind: 'auth', message: 'original refusal' } }
              : { state, progress: 0.25 },
        );
      }
      expect(removed).toBe(1);
      let quiet = false;
      void Promise.allSettled(retained).then(() => {
        quiet = true;
      });
      await until(() => quiet);
      expect(quiet).toBe(true);
    });

for (const failed of [false, true])
  for (const cleanup of ['live', 'mutate', 'throw'] as const)
    it(`submission owns its result and primary diagnosis before cleanup: failed=${failed}, ${cleanup}`, async () => {
      const cleanupFailure = new Error('private media cleanup fault');
      const diagnostic = {
        provider: 'openai' as const,
        kind: 'auth' as const,
        message: 'original media refusal',
        retryable: false,
      };
      const submission = { jobId: 'original-job', raw: {} };
      let removed = 0;
      const signal = {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => {
          removed++;
          if (cleanup === 'throw') throw cleanupFailure;
          if (cleanup === 'mutate') {
            submission.jobId = 'mutated-job';
            diagnostic.message = 'private mutation';
          }
        },
      };
      const runner = createAgentNodeExecutor({
        resolveProvider: () =>
          provider({
            generateMedia: () =>
              failed
                ? Promise.reject(new LlmProviderError(diagnostic))
                : Promise.resolve(submission),
          }),
        registry,
        tools: [],
        keyFor: () => 'offline-placeholder',
        sleep: () => Promise.resolve(),
        resolveMediaSurface: () => 'generative',
      });
      const host = createInMemoryHost();
      let checked = false;
      const handle = new WorkflowEngine({
        host,
        executor: {
          execute: async (ctx) => {
            const operation = runner.execute({ ...ctx, signal });
            if (!failed && cleanup === 'throw')
              await expect(operation).rejects.toBe(cleanupFailure);
            else {
              const outcome = await operation;
              expect(outcome).toMatchObject(
                failed
                  ? {
                      kind: 'failed',
                      error: { code: 'provider_auth', message: 'original media refusal' },
                    }
                  : { kind: 'media_job', job: { jobId: 'original-job' } },
              );
            }
            checked = true;
            return { kind: 'completed', output: 'checked owned submission' };
          },
        },
      }).start({ workflow: workflow(true) });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(checked).toBe(true);
      expect(removed).toBe(1);
      expect(events.at(-1)?.type).toBe('run:completed');
      expect((await handle.depart()).kind).toBe('closed');
      expect(await host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    });
