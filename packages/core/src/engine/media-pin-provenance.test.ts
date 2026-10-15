import { MediaAdmissionError, type MediaStore, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { NodeMediaPinError } from './media-pin-error.js';

const privateMessage = 'PRIVATE signed media URL and host diagnostic';
const handle = `media://sha256-${'a'.repeat(64)}`;
const fixedFormatMessage =
  'node `work` produced media that could not be re-hosted: Media structure is unsupported or incomplete.';
const fixedInternalMessage = 'node `work` produced media that could not be re-hosted (internal)';

function forgedPrototype(): Error {
  const error = new Error(privateMessage);
  Object.setPrototypeOf(error, NodeMediaPinError.prototype);
  Object.defineProperty(error, 'failure', {
    value: { code: 'provider_unavailable', message: privateMessage, retryable: true },
  });
  return error;
}

function mutatedRegistered(): Error {
  const error = NodeMediaPinError.from(new MediaAdmissionError('invalid_format'), 'work', false);
  Object.defineProperty(error, 'message', { value: privateMessage });
  Object.defineProperty(error, 'failure', {
    value: { code: 'provider_unavailable', message: privateMessage, retryable: true },
  });
  return error;
}

function forgedFailureGetter(): Error {
  const error = new Error(privateMessage);
  Object.setPrototypeOf(error, NodeMediaPinError.prototype);
  Object.defineProperty(error, 'failure', {
    get() {
      throw new Error(privateMessage);
    },
  });
  return error;
}

function forgedProxy(): Error {
  return new Proxy(new Error(privateMessage), {
    getPrototypeOf: () => NodeMediaPinError.prototype,
    get: (target, key, receiver) => {
      if (key === 'failure')
        return { code: 'provider_unavailable', message: privateMessage, retryable: true };
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });
}

async function runRejectingMedia(
  error: Error,
  source: 'media' | 'executor' = 'media',
): Promise<{
  readonly events: readonly RunEvent[];
  readonly durable: readonly RunEvent[];
  readonly executions: number;
}> {
  let executions = 0;
  const store = new InMemoryRunStore();
  const mediaStore: MediaStore = {
    put: () => Promise.resolve(handle),
    get: () => Promise.resolve(new Uint8Array(2)),
    readRange: () => Promise.resolve(new Uint8Array(2)),
    resolveForEgress: () => Promise.resolve({ kind: 'handle', ref: handle }),
    validateMedia: () => Promise.reject(error),
  };
  const host = createInMemoryHost({ store, mediaStore });
  const engine = new WorkflowEngine({
    host: {
      ...host,
      // Reference timers are manual. Drive an armed retry without a wall-clock sleep so a poisoned
      // retry policy reaches the execution-count witness instead of merely timing out this test.
      setTimer: (ms, onFire, kind) => {
        const disarm = host.setTimer(ms, onFire, kind);
        if (kind === undefined || kind === 'work') queueMicrotask(host.fireTimers);
        return disarm;
      },
    },
    executor: {
      execute: (context) => {
        if (context.vertex.id === 'work') {
          executions++;
          if (source === 'executor') return Promise.reject(error);
          return Promise.resolve({
            kind: 'completed',
            output: {
              type: 'media',
              mimeType: 'audio/L16',
              source: { kind: 'handle', ref: handle },
              byteLength: 2,
            },
          });
        }
        return Promise.resolve({ kind: 'completed', output: 'plain' });
      },
    },
  });
  const run = engine.start({
    workflow: parseWorkflow(`schema_version: '1.0'
workflow:
  id: pin-provenance
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'plain', retry: { max: 3, backoff: linear, backoff_ms: 1 } }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }
`),
  });
  const events: RunEvent[] = [];
  for await (const event of run.events) events.push(event);
  return { events, durable: store.eventsFor(run.runId), executions };
}

describe('media pin error provenance at the durable engine boundary', () => {
  it('an unowned forged prototype executor failure cannot bypass the dispatch classification', async () => {
    const { events, durable, executions } = await runRejectingMedia(forgedPrototype(), 'executor');
    expect(executions).toBe(1);
    for (const observed of [events, durable]) {
      expect(observed.filter((event) => event.type === 'node:failed')).toMatchObject([
        {
          error: {
            code: 'internal',
            message: 'the node handler threw an unexpected error',
            retryable: false,
          },
        },
      ]);
      expect(observed.some((event) => event.type === 'node:retrying')).toBe(false);
      expect(observed.at(-1)?.type).toBe('run:failed');
      expect(JSON.stringify(observed)).not.toContain(privateMessage);
    }
  });

  it.each([
    {
      name: 'forged prototype',
      make: forgedPrototype,
      code: 'internal',
      message: fixedInternalMessage,
    },
    {
      name: 'mutated registered pin',
      make: mutatedRegistered,
      code: 'validation',
      message: fixedFormatMessage,
    },
    {
      name: 'forged failure getter',
      make: forgedFailureGetter,
      code: 'internal',
      message: fixedInternalMessage,
    },
    {
      name: 'forged proxy prototype',
      make: forgedProxy,
      code: 'internal',
      message: fixedInternalMessage,
    },
  ])(
    '$name cannot publish private text or request another node execution',
    async ({ make, code, message }) => {
      const { events, durable, executions } = await runRejectingMedia(make());
      expect(executions).toBe(1);
      for (const observed of [events, durable]) {
        const failures = observed.filter((event) => event.type === 'node:failed');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ error: { code, message, retryable: false } });
        expect(observed.some((event) => event.type === 'node:retrying')).toBe(false);
        expect(observed.at(-1)).toMatchObject({
          type: 'run:failed',
          error: { code, message, retryable: false },
        });
        expect(JSON.stringify(observed)).not.toContain(privateMessage);
      }
    },
  );
});
