import { describe, expect, it, vi } from 'vitest';
import type { EffectDispatchPort, RetainedEffectEnvelope } from '@relavium/shared';
import { createAbortController, createInMemoryEffectJournal } from '../engine/execution-host.js';
import { unwiredEffectJournal, utf8ByteLength } from '@relavium/shared';
import { BUILTIN_TOOLS } from './builtins.js';
import { createToolRegistry } from './registry.js';
import { ToolExecutionError, ToolPreparationError } from './errors.js';
import type {
  FsCapability,
  ToolApprovalLiveContext,
  ToolDef,
  ToolDispatchContext,
  ToolLiveEvent,
} from './types.js';

const retained = (
  mapping: Readonly<Record<string, string>> | null = null,
): RetainedEffectEnvelope => ({
  v: 2,
  hasValue: true,
  value: { bytesWritten: 3 },
  hasMappedValue: false,
  outputMapping: mapping,
  truncated: false,
  summary: 'saved',
});
function context(overrides: Partial<ToolDispatchContext> = {}): ToolDispatchContext {
  return {
    nodeId: 'n',
    grantedToolIds: new Set(['edit_file', 'write_file', 'read_file']),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
    effectSlot: 0,
    effectAttempt: { providerAttempt: 1, toolCallId: 'engine-call' },
    effects: createInMemoryEffectJournal({ kind: 'run', runId: 'r', nodeId: 'n', attempt: 1 }),
    ...overrides,
  };
}
function fixture() {
  const execute = vi.fn(async () => {
    await Promise.resolve();
    return { path: 'a', bytesWritten: 3 };
  });
  const release = vi.fn(() => undefined);
  const prepareWrite = vi.fn<NonNullable<FsCapability['prepareWrite']>>(async () => {
    await Promise.resolve();
    return {
      path: 'a',
      before: 'old\n',
      after: 'new\n',
      execute,
      release,
    };
  });
  const fs: FsCapability = {
    prepareWrite,
    readFile: async () => {
      await Promise.resolve();
      return { content: 'old', mimeType: 'text/plain', sizeBytes: 3, lastModified: 't' };
    },
    writeFile: vi.fn(async () => {
      await Promise.resolve();
      throw new Error('legacy blind path');
    }),
    listDirectory: async () => {
      await Promise.resolve();
      return { entries: [] };
    },
  };
  const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs } });
  const call = {
    type: 'tool_call',
    id: 'provider-id',
    name: 'edit_file',
    args: { path: 'a', old_string: 'old', new_string: 'new' },
  } as const;
  return { execute, release, prepareWrite, registry, call };
}
function port(overrides: Partial<EffectDispatchPort> = {}): EffectDispatchPort {
  return {
    inspectReplay: vi.fn<EffectDispatchPort['inspectReplay']>(async () => {
      await Promise.resolve();
      return { outcome: 'miss' };
    }),
    prepare: vi.fn<EffectDispatchPort['prepare']>(async () => {
      await Promise.resolve();
      return { outcome: 'proceed' };
    }),
    settle: vi.fn(async () => {
      await Promise.resolve();
      return undefined;
    }),
    discard: vi.fn(async () => {
      await Promise.resolve();
      return undefined;
    }),
    ...overrides,
  };
}
describe('prepared filesystem dispatch and retained delivery', () => {
  it('freezes the review before approval, then journals, gates, executes and releases once', async () => {
    const f = fixture();
    const order: string[] = [];
    const effects = port({
      inspectReplay: async () => {
        await Promise.resolve();
        order.push('inspect');
        return { outcome: 'miss' };
      },
      prepare: async () => {
        await Promise.resolve();
        order.push('journal');
        return { outcome: 'proceed' };
      },
      settle: async () => {
        await Promise.resolve();
        order.push('settle');
      },
    });
    f.prepareWrite.mockImplementation(async () => {
      await Promise.resolve();
      order.push('file-prepare');
      return {
        path: 'a',
        before: 'old\n',
        after: 'new\n',
        execute: async () => {
          await Promise.resolve();
          order.push('execute');
          return { path: 'a', bytesWritten: 4 };
        },
        release: () => {
          order.push('release');
        },
      };
    });
    const committed = vi.fn();
    const events: ToolLiveEvent[] = [];
    await f.registry.dispatch(
      f.call,
      context({
        effects,
        beforeDispatch: () => {
          order.push('gate');
        },
        onToolLiveEvent: (event) => events.push(event),
        approval: {
          confirm: async (_request, _signal, live) => {
            await Promise.resolve();
            order.push('approval');
            expect(live?.preview.diff?.after).toBe('new\n');
            expect(Object.isFrozen(live?.preview.diff?.lines)).toBe(true);
            return { outcome: 'approve', onDispatchSucceeded: committed };
          },
        },
      }),
    );
    expect(order).toEqual([
      'inspect',
      'file-prepare',
      'approval',
      'journal',
      'gate',
      'execute',
      'settle',
      'release',
    ]);
    expect(committed).toHaveBeenCalledOnce();
    expect(events.map((event) => event.phase)).toEqual(['started', 'preview', 'completed']);
    expect(events.every((event) => event.callId === 'engine-call')).toBe(true);
  });
  it('denial releases read-only preparation and creates no row or mutation', async () => {
    const f = fixture();
    const effects = port();
    await expect(
      f.registry.dispatch(
        f.call,
        context({
          effects,
          approval: {
            confirm: async () => {
              await Promise.resolve();
              return { outcome: 'reject' };
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'tool_denied' });
    expect(effects.prepare).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([
    'read_required',
    'stale_file',
    'match_not_found',
    'match_not_unique',
    'unobserved_match',
    'unsupported_text',
    'diff_limit',
  ] as const)(
    'classifies only proven pre-effect %s as a correction without a journal row',
    async (reason) => {
      const f = fixture();
      const effects = port();
      const confirm = vi.fn();
      f.prepareWrite.mockRejectedValue(new ToolPreparationError(reason));
      await expect(
        f.registry.dispatch(f.call, context({ effects, approval: { confirm } })),
      ).rejects.toMatchObject({ code: 'execution_failed', recoverable: true, retryable: false });
      expect(effects.prepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('replays retained run effects without preparing or publishing and still confirms saved delivery', async () => {
    const f = fixture();
    const effects = port({
      inspectReplay: async () => {
        await Promise.resolve();
        return { outcome: 'replay', result: retained() };
      },
    });
    const mutationGrant = vi.fn();
    let liveContext: ToolApprovalLiveContext | undefined;
    const outcome = await f.registry.dispatch(
      f.call,
      context({
        effects,
        beforeDispatch: () => {
          throw new Error('replay must skip');
        },
        approval: {
          confirm: async (_req, _signal, live) => {
            await Promise.resolve();
            liveContext = live;
            return { outcome: 'approve', onDispatchSucceeded: mutationGrant };
          },
        },
      }),
    );
    expect(outcome.output).toEqual({ bytesWritten: 3 });
    expect(liveContext?.preview).toEqual({ kind: 'saved-result', fields: [] });
    expect(f.prepareWrite).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(effects.prepare).not.toHaveBeenCalled();
    expect(effects.settle).not.toHaveBeenCalled();
    expect(effects.discard).not.toHaveBeenCalled();
    expect(mutationGrant).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    async () => {
      await Promise.resolve();
      return { outcome: 'reject' as const };
    },
  ])('saved delivery never bypasses absent/denying confirmation', async (confirm) => {
    const f = fixture();
    const effects = port({
      inspectReplay: async () => {
        await Promise.resolve();
        return { outcome: 'replay', result: retained() };
      },
    });
    await expect(
      f.registry.dispatch(
        f.call,
        context({ effects, approval: confirm === undefined ? {} : { confirm } }),
      ),
    ).rejects.toMatchObject({ code: 'tool_denied', retryable: false });
    expect(f.prepareWrite).not.toHaveBeenCalled();
  });
  it('atomic prepare-race replaces the diff, releases it, confirms delivery and never commits provisional always', async () => {
    const f = fixture();
    const effects = port({
      prepare: async () => {
        await Promise.resolve();
        return { outcome: 'replay', result: retained() };
      },
    });
    const grant = vi.fn();
    const kinds: string[] = [];
    const events: ToolLiveEvent[] = [];
    await f.registry.dispatch(
      f.call,
      context({
        effects,
        onToolLiveEvent: (event) => events.push(event),
        approval: {
          confirm: async (_req, _signal, live) => {
            await Promise.resolve();
            kinds.push(live?.preview.kind ?? 'missing');
            return { outcome: 'approve', onDispatchSucceeded: grant };
          },
        },
      }),
    );
    expect(kinds).toEqual(['operation', 'saved-result']);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(effects.settle).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.phase === 'preview').map((event) => event.preview.kind),
    ).toEqual(['operation', 'saved-result']);
  });
  it.each([
    new Error('disk private'),
    new ToolExecutionError('edit_file', 'typed', undefined, { recoverable: true, retryable: true }),
  ])('inspection failure is fixed diagnostic and never retryable or recoverable', async (error) => {
    const f = fixture();
    const effects = port({
      inspectReplay: async () => {
        await Promise.resolve();
        throw error;
      },
    });
    await expect(f.registry.dispatch(f.call, context({ effects }))).rejects.toMatchObject({
      message: 'Retained effect inspection failed.',
      recoverable: false,
      retryable: false,
    });
    expect(f.prepareWrite).not.toHaveBeenCalled();
  });
  it.each([
    new Error('bad delivery'),
    new ToolExecutionError('edit_file', 'typed', undefined, { recoverable: true, retryable: true }),
  ])('marks a retained hit before generic or typed decoder faults', async (error) => {
    const f = fixture();
    const raw = new Proxy(retained(), {
      ownKeys: () => {
        throw error;
      },
    });
    const effects = port({
      inspectReplay: async () => {
        await Promise.resolve();
        return { outcome: 'replay', result: raw };
      },
    });
    await expect(f.registry.dispatch(f.call, context({ effects }))).rejects.toMatchObject({
      recoverable: false,
      retryable: false,
    });
    expect(effects.settle).not.toHaveBeenCalled();
    expect(effects.discard).not.toHaveBeenCalled();
  });
  it.each([{ changed: 'a' }, { key: 'changed' }, {}])(
    'rejects exact mapping drift before preparation',
    async (mapping) => {
      const f = fixture();
      const effects = port({
        inspectReplay: async () => {
          await Promise.resolve();
          return { outcome: 'replay', result: retained({ key: 'a' }) };
        },
      });
      await expect(
        f.registry.dispatch(f.call, context({ effects, config: { outputMapping: mapping } })),
      ).rejects.toMatchObject({ code: 'effect_conflict', retryable: false });
      expect(f.prepareWrite).not.toHaveBeenCalled();
    },
  );
  it('snapshots mapping at admission and compares member order structurally', async () => {
    const f = fixture();
    const result = {
      ...retained({ a: 'first', b: 'second' }),
      hasMappedValue: true,
      mapped: { picked: 7 },
    };
    const effects = port({
      inspectReplay: async () => {
        await Promise.resolve();
        return { outcome: 'replay', result };
      },
    });
    const out = await f.registry.dispatch(
      f.call,
      context({ effects, config: { outputMapping: { b: 'second', a: 'first' } } }),
    );
    expect(out.output).toEqual({ picked: 7 });
    expect(f.prepareWrite).not.toHaveBeenCalled();
  });
  it('publishes terminal lifecycle for validation failures with no provider-id correlation', async () => {
    const f = fixture();
    const events: ToolLiveEvent[] = [];
    await expect(
      f.registry.dispatch(
        { ...f.call, args: {} },
        context({ onToolLiveEvent: (event) => events.push(event) }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    expect(events).toEqual([
      { phase: 'started', callId: 'engine-call', toolId: 'edit_file' },
      { phase: 'completed', callId: 'engine-call', toolId: 'edit_file', outcome: 'failure' },
    ]);
  });
  it('never grants prepared behavior to an external tool declaration', async () => {
    const f = fixture();
    const prepare = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('external');
    });
    const def: ToolDef = {
      id: 'edit_file',
      source: 'mcp',
      description: '',
      parseArgs: (args) => args,
      llmVisibleParams: {},
      policy: { fsScoped: true, fsWrite: true, spawnsProcess: false, requiresGateApproval: false },
      prepare,
      dispatch: async () => {
        await Promise.resolve();
        return { ok: true };
      },
      effect: () => 3,
    };
    const effects = port();
    await createToolRegistry({ tools: [def], host: {} }).dispatch(f.call, context({ effects }));
    expect(prepare).not.toHaveBeenCalled();
    expect(effects.inspectReplay).not.toHaveBeenCalled();
  });
  for (const entry of ['inspection', 'atomic'] as const) {
    it.each([
      new Error('delivery'),
      new ToolExecutionError('edit_file', 'typed delivery', undefined, {
        retryable: true,
        recoverable: true,
      }),
    ])(
      `${entry} hit keeps generic and typed final-delivery failures off both retry paths`,
      async (error) => {
        const f = fixture();
        const effects = port(
          entry === 'inspection'
            ? { inspectReplay: () => Promise.resolve({ outcome: 'replay', result: retained() }) }
            : { prepare: () => Promise.resolve({ outcome: 'replay', result: retained() }) },
        );
        const call = {
          ...f.call,
          get id(): string {
            throw error;
          },
        };
        await expect(f.registry.dispatch(call, context({ effects }))).rejects.toMatchObject({
          recoverable: false,
          retryable: false,
        });
        expect(f.execute).not.toHaveBeenCalled();
        expect(effects.settle).not.toHaveBeenCalled();
        expect(effects.discard).not.toHaveBeenCalled();
      },
    );
  }
  it('an explicitly absent mapped result never falls back to the bounded saved value', async () => {
    const f = fixture();
    const effects = port({
      inspectReplay: () =>
        Promise.resolve({ outcome: 'replay', result: retained({ missing: 'path' }) }),
    });
    const outcome = await f.registry.dispatch(
      f.call,
      context({ effects, config: { outputMapping: { missing: 'path' } } }),
    );
    expect(outcome.output).toBeUndefined();
  });
  it('a failed release cannot turn a user denial into a retryable error', async () => {
    const f = fixture();
    f.prepareWrite.mockImplementation(() =>
      Promise.resolve({
        path: 'a',
        before: 'old',
        after: 'new',
        execute: f.execute,
        release: () => Promise.reject(new Error('cleanup')),
      }),
    );
    await expect(
      f.registry.dispatch(
        f.call,
        context({ approval: { confirm: () => Promise.resolve({ outcome: 'reject' }) } }),
      ),
    ).rejects.toMatchObject({ code: 'tool_denied', retryable: false });
  });
  for (const entry of ['inspection', 'atomic'] as const) {
    it(`${entry} replay refuses changed destination/path and absent-vs-empty declarations`, async () => {
      for (const mapping of [undefined, {}, { other: 'a' }, { key: 'changed' }]) {
        const f = fixture();
        const result = retained({ key: 'a' });
        const effects = port(
          entry === 'inspection'
            ? { inspectReplay: () => Promise.resolve({ outcome: 'replay', result }) }
            : { prepare: () => Promise.resolve({ outcome: 'replay', result }) },
        );
        await expect(
          f.registry.dispatch(
            f.call,
            context({ effects, config: mapping === undefined ? {} : { outputMapping: mapping } }),
          ),
        ).rejects.toMatchObject({ code: 'effect_conflict', retryable: false, recoverable: false });
        expect(f.execute).not.toHaveBeenCalled();
        expect(effects.settle).not.toHaveBeenCalled();
        expect(effects.discard).not.toHaveBeenCalled();
      }
    });
  }
  it('mapping admission snapshot drives both the first output and retained envelope after caller mutation', async () => {
    const f = fixture();
    const effects = port();
    const mapping = { selected: 'bytesWritten' };
    const out = await f.registry.dispatch(
      f.call,
      context({
        effects,
        config: { outputMapping: mapping },
        approval: {
          confirm: () => {
            mapping.selected = 'path';
            return Promise.resolve({ outcome: 'approve' });
          },
        },
      }),
    );
    expect(out.output).toEqual({ selected: 3 });
    expect(effects.settle).toHaveBeenCalledWith(
      0,
      'edit_file',
      'committed',
      expect.objectContaining({
        outputMapping: { selected: 'bytesWritten' },
        hasMappedValue: true,
        mapped: { selected: 3 },
      }),
    );
  });
  it('a denial of prepare-race saved delivery leaves no mutation authority or second journal write', async () => {
    const f = fixture();
    const effects = port({
      prepare: () => Promise.resolve({ outcome: 'replay', result: retained() }),
    });
    const grant = vi.fn();
    await expect(
      f.registry.dispatch(
        f.call,
        context({
          effects,
          approval: {
            confirm: (_request, _signal, live) =>
              Promise.resolve(
                live?.preview.kind === 'saved-result'
                  ? { outcome: 'reject' }
                  : { outcome: 'approve', onDispatchSucceeded: grant },
              ),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'tool_denied', retryable: false });
    expect(f.execute).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(effects.settle).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('a same-shaped edit refusal from execution is fatal and retains ambiguous effect evidence', async () => {
    const f = fixture();
    const effects = port();
    f.execute.mockRejectedValue(new ToolPreparationError('stale_file'));
    await expect(f.registry.dispatch(f.call, context({ effects }))).rejects.toMatchObject({
      recoverable: false,
      retryable: false,
    });
    expect(effects.settle).toHaveBeenCalledWith(0, 'edit_file', 'ambiguous');
  });
});

const WRITE_VARIANTS = [
  { name: 'create', args: { path: 'a', content: 'new\n' }, before: null, after: 'new\n' },
  {
    name: 'overwrite-omitted',
    args: { path: 'a', content: 'new\n' },
    before: 'old\n',
    after: 'new\n',
  },
  {
    name: 'overwrite-false',
    args: { path: 'a', content: 'new\n', append: false },
    before: 'old\n',
    after: 'new\n',
  },
  {
    name: 'append',
    args: { path: 'a', content: 'tail\n', append: true },
    before: 'old\n',
    after: 'old\ntail\n',
  },
  { name: 'empty', args: { path: 'a', content: '' }, before: 'old\n', after: '' },
  { name: 'unchanged', args: { path: 'a', content: 'same\n' }, before: 'same\n', after: 'same\n' },
  {
    name: 'create-dirs-empty',
    args: { path: 'parent/a', content: '', createDirs: true },
    before: null,
    after: '',
  },
];
function writeFixture(variant: (typeof WRITE_VARIANTS)[number]) {
  const f = fixture();
  f.prepareWrite.mockImplementation(() =>
    Promise.resolve({
      path: variant.args.path,
      before: variant.before,
      after: variant.after,
      execute: f.execute,
      release: f.release,
    }),
  );
  const call = {
    type: 'tool_call',
    id: 'provider-write',
    name: 'write_file',
    args: variant.args,
  } as const;
  return { ...f, call };
}
describe.each(WRITE_VARIANTS)('ADR-0125 $name dispatch', (variant) => {
  it('requires a wired journal before any filesystem preparation', async () => {
    const f = writeFixture(variant);
    await expect(
      f.registry.dispatch(f.call, context({ effects: unwiredEffectJournal() })),
    ).rejects.toMatchObject({
      message: 'Retained effect inspection failed.',
      recoverable: false,
      retryable: false,
    });
    expect(f.prepareWrite).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('admits a read-only diff before approval and durably claims before publication', async () => {
    const f = writeFixture(variant);
    const journal = createInMemoryEffectJournal({
      kind: 'run',
      runId: 'r',
      nodeId: 'n',
      attempt: 1,
    });
    let approved = false;
    f.execute.mockImplementation(() => {
      expect(approved).toBe(true);
      expect(journal.rows()[0]).toMatchObject({ toolId: 'write_file', tier: 3, state: 'prepared' });
      return Promise.resolve({
        path: variant.args.path,
        bytesWritten: utf8ByteLength(variant.after),
      });
    });
    await f.registry.dispatch(
      f.call,
      context({
        effects: journal,
        approval: {
          confirm: (_request, _signal, live) => {
            expect(journal.rows()).toEqual([]);
            expect(f.execute).not.toHaveBeenCalled();
            expect(live?.preview.diff).toMatchObject({
              before: variant.before,
              after: variant.after,
            });
            approved = true;
            return Promise.resolve({ outcome: 'approve' });
          },
        },
      }),
    );
    expect(journal.rows()[0]).toMatchObject({ toolId: 'write_file', tier: 3, state: 'committed' });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('denial and read-only preparation refusal leave no durable row or mutation', async () => {
    for (const refusal of ['deny', 'preparation'] as const) {
      const f = writeFixture(variant);
      const journal = createInMemoryEffectJournal({
        kind: 'run',
        runId: 'r',
        nodeId: 'n',
        attempt: 1,
      });
      if (refusal === 'preparation')
        f.prepareWrite.mockRejectedValue(new ToolPreparationError('diff_limit'));
      await expect(
        f.registry.dispatch(
          f.call,
          context({
            effects: journal,
            approval: { confirm: () => Promise.resolve({ outcome: 'reject' }) },
          }),
        ),
      ).rejects.toMatchObject(
        refusal === 'deny'
          ? { code: 'tool_denied', retryable: false }
          : { code: 'execution_failed', recoverable: true, retryable: false },
      );
      expect(journal.rows()).toEqual([]);
      expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('cancellation during approval leaves no durable claim', async () => {
    const f = writeFixture(variant);
    const journal = createInMemoryEffectJournal({
      kind: 'run',
      runId: 'r',
      nodeId: 'n',
      attempt: 1,
    });
    const controller = createAbortController();
    await expect(
      f.registry.dispatch(
        f.call,
        context({
          effects: journal,
          signal: controller.signal,
          approval: {
            confirm: () => {
              controller.abort();
              return Promise.resolve({ outcome: 'approve' });
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    expect(journal.rows()).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  for (const entry of ['inspection', 'atomic'] as const) {
    it(`${entry} replay confirms only saved delivery and commits no mutation grant`, async () => {
      const f = writeFixture(variant);
      const grant = vi.fn();
      const kinds: string[] = [];
      const effects = port(
        entry === 'inspection'
          ? { inspectReplay: () => Promise.resolve({ outcome: 'replay', result: retained() }) }
          : { prepare: () => Promise.resolve({ outcome: 'replay', result: retained() }) },
      );
      await f.registry.dispatch(
        f.call,
        context({
          effects,
          approval: {
            confirm: (_request, _signal, live) => {
              kinds.push(live?.preview.kind ?? 'missing');
              return Promise.resolve({ outcome: 'approve', onDispatchSucceeded: grant });
            },
          },
        }),
      );
      expect(kinds).toEqual(
        entry === 'inspection' ? ['saved-result'] : ['operation', 'saved-result'],
      );
      expect(f.prepareWrite).toHaveBeenCalledTimes(entry === 'inspection' ? 0 : 1);
      expect(f.execute).not.toHaveBeenCalled();
      expect(grant).not.toHaveBeenCalled();
      expect(effects.settle).not.toHaveBeenCalled();
      expect(effects.discard).not.toHaveBeenCalled();
    });
    it(`${entry} replay compares the declaration and retains explicitly absent mapped output`, async () => {
      for (const match of [false, true]) {
        const f = writeFixture(variant);
        const result = retained({ selected: 'bytesWritten' });
        const effects = port(
          entry === 'inspection'
            ? { inspectReplay: () => Promise.resolve({ outcome: 'replay', result }) }
            : { prepare: () => Promise.resolve({ outcome: 'replay', result }) },
        );
        const resultPromise = f.registry.dispatch(
          f.call,
          context({
            effects,
            config: { outputMapping: match ? { selected: 'bytesWritten' } : { selected: 'path' } },
          }),
        );
        if (match) expect((await resultPromise).output).toBeUndefined();
        else
          await expect(resultPromise).rejects.toMatchObject({
            code: 'effect_conflict',
            recoverable: false,
            retryable: false,
          });
        expect(f.execute).not.toHaveBeenCalled();
        expect(effects.settle).not.toHaveBeenCalled();
        expect(effects.discard).not.toHaveBeenCalled();
      }
    });
    it(`${entry} hit keeps both typed and generic final delivery faults nonretryable`, async () => {
      for (const error of [
        new Error('delivery'),
        new ToolExecutionError('write_file', 'typed', undefined, {
          recoverable: true,
          retryable: true,
        }),
      ]) {
        const f = writeFixture(variant);
        const result = retained();
        const effects = port(
          entry === 'inspection'
            ? { inspectReplay: () => Promise.resolve({ outcome: 'replay', result }) }
            : { prepare: () => Promise.resolve({ outcome: 'replay', result }) },
        );
        await expect(
          f.registry.dispatch(
            {
              ...f.call,
              get id(): string {
                throw error;
              },
            },
            context({ effects }),
          ),
        ).rejects.toMatchObject({ recoverable: false, retryable: false });
        expect(f.execute).not.toHaveBeenCalled();
        expect(effects.settle).not.toHaveBeenCalled();
        expect(effects.discard).not.toHaveBeenCalled();
      }
    });
  }
  it('preserves fatal typed metadata-preparation refusal outside correction feedback', async () => {
    const f = writeFixture(variant);
    const journal = createInMemoryEffectJournal({
      kind: 'run',
      runId: 'r',
      nodeId: 'n',
      attempt: 1,
    });
    f.prepareWrite.mockRejectedValue(
      new ToolExecutionError('write_file', 'File metadata policy refused.', undefined, {
        recoverable: false,
        retryable: false,
      }),
    );
    await expect(f.registry.dispatch(f.call, context({ effects: journal }))).rejects.toMatchObject({
      message: 'File metadata policy refused.',
      recoverable: false,
      retryable: false,
    });
    expect(journal.rows()).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
