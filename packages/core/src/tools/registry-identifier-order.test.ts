import { unwiredEffectJournal, type EffectDispatchPort } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ToolArgsInvalidError, UnknownToolError } from './errors.js';
import { createToolRegistry } from './registry.js';
import type {
  FsCapability,
  ToolCallPart,
  ToolDef,
  ToolDispatchContext,
  ToolHost,
} from './types.js';
import { unwrapUntrusted } from './untrusted.js';

const ids = ['a_b', 'a-b', 'a', 'Z'];
const expected = ['Z', 'a', 'a-b', 'a_b'];
const canary = 'ARGUMENT-VALUE-CANARY';

function call(name: string, args: unknown = {}): ToolCallPart {
  return { type: 'tool_call', id: 'ordering-call', name, args };
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('expected registry refusal');
}

function fixture(
  parse: ToolDef['parseArgs'] = (raw) => raw,
  configOnlyParams: readonly string[] = [],
  includeProbe = true,
) {
  const readFile = vi.fn<FsCapability['readFile']>(() =>
    Promise.resolve({
      content: 'clean probe output',
      mimeType: 'text/plain',
      sizeBytes: 18,
      lastModified: 'fixed',
    }),
  );
  const host: ToolHost = {
    fs: {
      readFile,
      writeFile: () => {
        throw new Error('unexpected write');
      },
      listDirectory: () => {
        throw new Error('unexpected directory read');
      },
    },
  };
  const parseArgs = vi.fn<ToolDef['parseArgs']>(parse);
  const policyTarget = vi.fn<NonNullable<ToolDef['policyTarget']>>(() => ({
    path: 'public-probe.txt',
  }));
  const dispatch = vi.fn<ToolDef['dispatch']>((_args, toolHost) => {
    if (toolHost.fs === undefined) throw new Error('missing fixture filesystem');
    return toolHost.fs.readFile('public-probe.txt', {});
  });
  const beforeDispatch = vi.fn<NonNullable<ToolDispatchContext['beforeDispatch']>>();
  const port = unwiredEffectJournal();
  const prepare = vi.fn<EffectDispatchPort['prepare']>((...args) => port.prepare(...args));
  const settle = vi.fn<EffectDispatchPort['settle']>((...args) => port.settle(...args));
  const discard = vi.fn<EffectDispatchPort['discard']>((...args) => port.discard(...args));
  const probe: ToolDef = {
    id: 'probe',
    source: 'plugin',
    description: 'Read public probe data.',
    llmVisibleParams: { type: 'object' },
    policy: { fsScoped: true, spawnsProcess: false, requiresGateApproval: false },
    configOnlyParams,
    parseArgs,
    policyTarget,
    dispatch,
  };
  const context: ToolDispatchContext = {
    nodeId: 'ordering-node',
    grantedToolIds: new Set([...ids, 'probe']),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: { prepare, settle, discard },
    effectSlot: 0,
    beforeDispatch,
  };
  const registry = createToolRegistry({
    tools: [...(includeProbe ? [probe] : []), ...ids.map((id) => ({ ...probe, id }))],
    host,
  });
  function assertBeforeDispatch(): void {
    for (const spy of [dispatch, readFile, beforeDispatch, prepare, settle, discard])
      expect(spy, 'identifier refusal precedes host admission and effects').not.toHaveBeenCalled();
  }
  return {
    registry,
    context,
    parseArgs,
    policyTarget,
    dispatch,
    readFile,
    beforeDispatch,
    prepare,
    settle,
    discard,
    assertBeforeDispatch,
  };
}

function assertInvalid(error: unknown, fields: readonly string[], message: string): void {
  expect(error).toBeInstanceOf(ToolArgsInvalidError);
  if (!(error instanceof ToolArgsInvalidError)) throw new Error('expected typed invalid arguments');
  expect(error.code).toBe('invalid_args');
  expect(error.runErrorCode).toBe('validation');
  expect(error.retryable).toBe(false);
  expect(error.fields, 'effective field identifiers use fixed ordinal order').toEqual(fields);
  expect(error.message).toBe(message);
  expect(error.message).not.toContain(canary);
}

describe('real registry identifier consumers (#259)', () => {
  it('lists actual plugin identifiers in fixed ordinal order with case-sensitive lookup', () => {
    const { registry } = fixture((raw) => raw, [], false);
    expect(registry.list(), 'registry list uses ordinal identifiers').toEqual(expected);
    expect(registry.has('Z')).toBe(true);
    expect(registry.has('z')).toBe(false);
  });

  it('actual unknown dispatch names available identifiers in fixed ordinal order', async () => {
    const h = fixture((raw) => raw, [], false);
    const error = await rejection(h.registry.dispatch(call('missing'), h.context));
    expect(error).toBeInstanceOf(UnknownToolError);
    if (!(error instanceof UnknownToolError)) throw new Error('expected typed unknown tool');
    expect(error.code).toBe('unknown_tool');
    expect(error.runErrorCode).toBe('tool_failed');
    expect(error.message, 'actual unknown-tool consumer preserves ordinal available IDs').toBe(
      'unknown tool `missing` — available tools: Z, a, a-b, a_b',
    );
    expect(h.parseArgs).not.toHaveBeenCalled();
    h.assertBeforeDispatch();
  });

  it.each(['model', 'effective-mixed'] as const)(
    'effective secret fields are ordered before schema, targets, host or effects: %s',
    async (source) => {
      const h = fixture((raw) => raw, source === 'effective-mixed' ? ['Z'] : []);
      const args =
        source === 'model'
          ? { a_b: canary, 'a-b': canary, a: canary, Z: canary }
          : { a_b: canary, 'a-b': 'model-overridden', a: 'model-overridden', Z: 'model-dropped' };
      const context: ToolDispatchContext = {
        ...h.context,
        secretArgKeys: new Set(ids),
        ...(source === 'model'
          ? {}
          : {
              config: {
                inputMapping: { 'a-b': canary, a: canary, Z: 'mapping-dropped' },
                parameters: { Z: canary },
              },
            }),
      };
      const error = await rejection(h.registry.dispatch(call('probe', args), context));
      assertInvalid(
        error,
        expected,
        'tool `probe`: a secret-typed value cannot flow into tool arguments (Z, a, a-b, a_b) — use a credential reference (ADR-0029)',
      );
      expect(h.parseArgs).not.toHaveBeenCalled();
      expect(h.policyTarget).not.toHaveBeenCalled();
      h.assertBeforeDispatch();
    },
  );

  it('real Zod issue field paths use ordinal order and omit received argument values', async () => {
    const schema = z.object({ a_b: z.string(), 'a-b': z.string(), a: z.string(), Z: z.string() });
    const h = fixture((raw) => schema.parse(raw));
    const error = await rejection(
      h.registry.dispatch(
        call('probe', { a_b: [canary], 'a-b': [canary], a: [canary], Z: [canary] }),
        h.context,
      ),
    );
    assertInvalid(error, expected, 'tool `probe`: invalid arguments (Z, a, a-b, a_b)');
    expect(h.parseArgs).toHaveBeenCalledOnce();
    expect(h.policyTarget).not.toHaveBeenCalled();
    h.assertBeforeDispatch();
  });

  it('real nested and array Zod paths retain dot joining and de-duplicate repeated issue paths', async () => {
    const repeated = z.string().superRefine((_value, context) => {
      context.addIssue({ code: 'custom', message: canary });
      context.addIssue({ code: 'custom', message: canary });
    });
    const schema = z.object({
      a_b: z.array(repeated),
      'a-b': z.object({ inner: z.string() }),
      Z: z.object({ inner: z.string() }),
    });
    const h = fixture((raw) => schema.parse(raw));
    const error = await rejection(
      h.registry.dispatch(call('probe', { a_b: [canary], 'a-b': {}, Z: {} }), h.context),
    );
    assertInvalid(
      error,
      ['Z.inner', 'a-b.inner', 'a_b.0'],
      'tool `probe`: invalid arguments (Z.inner, a-b.inner, a_b.0)',
    );
    expect(h.parseArgs).toHaveBeenCalledOnce();
    h.assertBeforeDispatch();
  });

  it('clean real dispatch reaches parser, target, admission and host with exact output', async () => {
    const schema = z.object({ a_b: z.string(), 'a-b': z.string(), a: z.string(), Z: z.string() });
    const h = fixture((raw) => schema.parse(raw));
    const args = { a_b: 'four', 'a-b': 'three', a: 'two', Z: 'one' };
    const outcome = await h.registry.dispatch(call('probe', args), h.context);
    expect(h.parseArgs).toHaveBeenCalledExactlyOnceWith(args);
    expect(h.policyTarget).toHaveBeenCalledExactlyOnceWith(args);
    expect(h.beforeDispatch).toHaveBeenCalledExactlyOnceWith('probe');
    expect(h.readFile).toHaveBeenCalledExactlyOnceWith('public-probe.txt', {});
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(outcome.output).toEqual({
      content: 'clean probe output',
      mimeType: 'text/plain',
      sizeBytes: 18,
      lastModified: 'fixed',
    });
    expect(unwrapUntrusted(outcome.toolResult)).toMatchObject({
      type: 'tool_result',
      toolCallId: 'ordering-call',
      result: outcome.output,
    });
    expect(outcome.events.result).toMatchObject({ toolId: 'probe', success: true });
    for (const spy of [h.prepare, h.settle, h.discard]) expect(spy).not.toHaveBeenCalled();
  });
});
