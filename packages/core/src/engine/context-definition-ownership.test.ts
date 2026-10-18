/** ADR-0113: taint classification and raw resolution share one owned context definition snapshot. */
import type { RunEvent, Workflow } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import { createWorkflowProvenance } from '../interpolation/provenance.js';
import { resolveContext } from '../interpolation/resolve.js';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import { createStandardNodeExecutor } from './node-handlers/dispatcher.js';
import type { RunHandle } from './run-handle.js';

const CANARY = 'ADR0113-CONTEXT-DEFINITION-PRIVATE-CANARY';
const INPUTS = { token: CANARY, path: 'public-file' };
let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

type Read = 'clean' | 'denied';

function workflow(read: Read, options: { blocked?: boolean; gated?: boolean } = {}) {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'context-definition-ownership',
        inputs: [
          { name: 'token', type: 'secret' },
          { name: 'path', type: 'string' },
        ],
        context: [
          ...(options.blocked ? [{ key: 'doc', value: '{{ inputs.path | read_file }}' }] : []),
          { key: 'clean', value: 'public' },
          { key: 'alias', value: '{{ inputs.token }}' },
          { key: 'nested', value: '{{ ctx.alias }}' },
        ],
        nodes: [
          ...(options.gated
            ? [
                {
                  id: 'gate',
                  type: 'human_gate',
                  gate_type: 'approval',
                  message_template: 'Review {{ ctx.clean }}',
                },
              ]
            : []),
          {
            id: 'result',
            type: 'transform',
            transform:
              read === 'denied'
                ? "(() => { try { return ctx.nested; } catch { return 'escaped'; } })()"
                : `({ clean: ctx.clean, keys: Object.keys(ctx)${options.blocked ? ', doc: ctx.doc' : ''} })`,
          },
        ],
        edges: options.gated ? [{ from: 'gate', to: 'result' }] : [],
      },
    }),
  );
}

function definitions(wf: Workflow) {
  const context = wf.workflow.context;
  if (context === undefined) throw new Error('fixture context missing');
  return context;
}

function entry(wf: Workflow, key: string) {
  const found = definitions(wf).find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`fixture context entry ${key} missing`);
  return found;
}

async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (settle === undefined) throw new Error('deferred fixture was not initialized');
      settle(value);
    },
  };
}

function assertOutcome(events: readonly RunEvent[], read: Read, blocked = false): void {
  if (read === 'clean') {
    expect(events.at(-1)?.type).toBe('run:completed');
    expect(events, 'WORKFLOW_CONTEXT_DEFINITION_OWNERSHIP').toContainEqual(
      expect.objectContaining({
        type: 'node:completed',
        nodeId: 'result',
        output: {
          clean: 'public',
          keys: [...(blocked ? ['doc'] : []), 'clean', 'alias', 'nested'],
          ...(blocked ? { doc: 'public-file-content' } : {}),
        },
      }),
    );
  } else {
    expect(events.at(-1)?.type).toBe('run:failed');
    expect(
      events.find((event) => event.type === 'node:failed' && event.nodeId === 'result'),
    ).toMatchObject({
      type: 'node:failed',
      nodeId: 'result',
      error: { code: 'sandbox_error', retryable: false },
    });
    expect(
      events.some((event) => event.type === 'node:completed' && event.nodeId === 'result'),
    ).toBe(false);
  }
  expect(JSON.stringify(events)).not.toContain(CANARY);
}

const mutations: { name: string; apply: (wf: Workflow) => void }[] = [
  {
    name: 'clean value changed to a secret reference',
    apply: (wf) => {
      entry(wf, 'clean').value = '{{ inputs.token }}';
    },
  },
  {
    name: 'secret value changed to a public literal',
    apply: (wf) => {
      entry(wf, 'alias').value = 'replacement-public';
    },
  },
  {
    name: 'secret entry renamed to overwrite a clean key',
    apply: (wf) => {
      entry(wf, 'alias').key = 'clean';
    },
  },
  {
    name: 'array appended with a secret overwrite of a clean key',
    apply: (wf) => {
      definitions(wf).push({ key: 'clean', value: '{{ inputs.token }}' });
    },
  },
  {
    name: 'array reordered before its transitive dependency',
    apply: (wf) => {
      definitions(wf).reverse();
    },
  },
  {
    name: 'array replaced with public definitions',
    apply: (wf) => {
      wf.workflow.context = [{ key: 'clean', value: 'replacement-public' }];
    },
  },
];

describe('owned context definitions at actual engine consumers (ADR-0113)', () => {
  describe.each<Read>(['clean', 'denied'])('%s expression', (read) => {
    for (const { name, apply } of mutations) {
      it(`ignores immediate caller mutation: ${name}`, async () => {
        const wf = workflow(read);
        const engine = new WorkflowEngine({
          host: createInMemoryHost(),
          executor: createStandardNodeExecutor({ sandbox }),
        });
        const handle = engine.start({ workflow: wf, inputs: INPUTS });
        apply(wf);
        assertOutcome(await drain(handle), read);
      });
    }

    it('ignores mutation of not-yet-resolved definitions while a context read is blocked', async () => {
      const wf = workflow(read, { blocked: true });
      const entered = deferred<void>();
      const release = deferred<string>();
      const paths: string[] = [];
      const engine = new WorkflowEngine({
        host: createInMemoryHost(),
        executor: createStandardNodeExecutor({ sandbox }),
        resolverCapabilities: {
          readFile: (path) => {
            paths.push(path);
            entered.resolve(undefined);
            return release.promise;
          },
        },
      });
      const handle = engine.start({ workflow: wf, inputs: INPUTS });
      const events = drain(handle);
      await entered.promise;
      entry(wf, 'clean').value = '{{ inputs.token }}';
      entry(wf, 'alias').key = 'clean';
      entry(wf, 'nested').value = 'replacement-public';
      definitions(wf).push({ key: 'extra', value: '{{ inputs.token }}' });
      release.resolve('public-file-content');
      assertOutcome(await events, read, true);
      expect(paths).toEqual(['public-file']);
    });

    it('retains the originally owned context definitions through same-process human resume', async () => {
      const wf = workflow(read, { gated: true });
      const engine = new WorkflowEngine({
        host: createInMemoryHost(),
        executor: createStandardNodeExecutor({ sandbox }),
      });
      const handle = engine.start({ workflow: wf, inputs: INPUTS });
      const events: RunEvent[] = [];
      let paused = false;
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'human_gate:paused') {
          expect(event.message).toBe('Review public');
          entry(wf, 'clean').value = '{{ inputs.token }}';
          entry(wf, 'alias').key = 'clean';
          definitions(wf).reverse();
          paused = true;
          await engine.resume(handle.runId, event.gateId, {
            decision: 'approved',
            decidedBy: 'context-ownership-test',
          });
        }
      }
      expect(paused).toBe(true);
      assertOutcome(events, read);
    });
  });

  it('owns frozen definitions for both derivation and resolution while the trusted raw API stays live', async () => {
    const wf = workflow('clean');
    const original = definitions(wf);
    const provenance = createWorkflowProvenance(wf);
    const owned = provenance.contextSource.workflow.context;
    expect(owned).not.toBe(original);
    expect(owned?.[0]).not.toBe(original[0]);
    expect(Object.isFrozen(provenance.contextSource)).toBe(true);
    expect(Object.isFrozen(provenance.contextSource.workflow)).toBe(true);
    expect(Object.isFrozen(owned)).toBe(true);
    for (const definition of owned ?? []) expect(Object.isFrozen(definition)).toBe(true);

    entry(wf, 'clean').value = '{{ inputs.token }}';
    entry(wf, 'alias').value = 'replacement-public';
    original.push({ key: 'extra', value: 'added-public' });
    const resolved = await resolveContext(provenance.contextSource, INPUTS);
    expect(resolved).toEqual({ clean: 'public', alias: CANARY, nested: CANARY });
    expect(provenance.qualifyContext(resolved)).toEqual({
      values: { clean: 'public' },
      deniedKeys: ['alias', 'nested'],
      orderedKeys: ['clean', 'alias', 'nested'],
    });
    expect(await resolveContext(wf, INPUTS)).toEqual({
      clean: CANARY,
      alias: 'replacement-public',
      nested: 'replacement-public',
      extra: 'added-public',
    });
  });
});
