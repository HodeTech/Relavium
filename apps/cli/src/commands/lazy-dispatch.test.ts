import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileCatalogSeed } from '../process/file-catalog-seed.js';
import { createCliInvocation } from '../process/invocation.js';
import { COMMAND_DESCRIPTORS } from './descriptors.js';
import type { CommandInput, DispatchCommand, DispatchContext } from './input.js';

// These are route-boundary tests: executors are doubles, not eleven production DB-owner journeys.
const PRICED = [
  'run',
  'chat',
  'chat-resume',
  'agent.run',
  'gate',
  'budget.resume',
  'models',
  'models.refresh',
  'models.pricing',
];
const UNPRICED = [
  'chat-list',
  'chat-export',
  'create',
  'export',
  'import',
  'gate.list',
  'list',
  'logs',
  'status',
  'provider.list',
  'provider.add',
  'provider.set-key',
  'provider.remove-key',
  'provider.test',
];
const INPUT: CommandInput = { positionals: ['literal-model-or-file'], options: {} };
let events: string[];
let execute: ReturnType<typeof vi.fn<DispatchCommand>>;
let media: ReturnType<typeof vi.fn>;

function context(seed: () => Promise<void>): DispatchContext {
  return {
    invocation: { ...createCliInvocation(), seedFileCatalogOnce: seed },
    io: {
      writeOut: () => undefined,
      writeErr: () => undefined,
      writeOutAcknowledged: () => Promise.resolve(),
      writeErrAcknowledged: () => Promise.resolve(),
      env: {},
      stdoutIsTty: false,
      stdinIsTty: false,
      stdin: Readable.from([]),
    },
    global: {
      json: false,
      color: false,
      cwd: '/unused',
      configPath: undefined,
      verbosity: 'normal',
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  events = [];
  execute = vi.fn<DispatchCommand>(() => {
    events.push('execute');
    return Promise.resolve(0);
  });
  media = vi.fn(() => Promise.resolve(0));
  vi.doMock('./dispatch.js', () => {
    events.push('import runtime');
    return { executeCommand: execute };
  });
  vi.doMock('./media.js', () => {
    events.push('import media');
    return { pruneTemporariesCommand: media };
  });
});

afterEach(() => {
  vi.doUnmock('./dispatch.js');
  vi.doUnmock('./media.js');
});

describe('finite lazy route boundary (ADR-0111)', () => {
  it('binds every advertised executor exactly once without importing its runtime', async () => {
    const { LAZY_COMMAND_IDS } = await import('./lazy-dispatch.js');
    const advertised = COMMAND_DESCRIPTORS.flatMap((descriptor) =>
      descriptor.executorId === undefined ? [] : [descriptor.executorId],
    );
    expect(LAZY_COMMAND_IDS).toHaveLength(24);
    expect(new Set(LAZY_COMMAND_IDS).size).toBe(24);
    expect([...LAZY_COMMAND_IDS].sort()).toEqual([...advertised].sort());
    expect([...LAZY_COMMAND_IDS].sort()).toEqual(
      [...PRICED, ...UNPRICED, 'media.prune-temporaries'].sort(),
    );
    expect(events).toEqual([]);
  });

  it.each(PRICED)('%s awaits the seed before importing or executing runtime', async (id) => {
    const { executeLazyCommand } = await import('./lazy-dispatch.js');
    let release: () => void = () => undefined;
    const seed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push('seed');
          release = resolve;
        }),
    );
    const ctx = context(seed);
    const result = executeLazyCommand(id, INPUT, ctx);
    expect(events).toEqual(['seed']);
    expect(execute).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBe(0);
    expect(events).toEqual(['seed', 'import runtime', 'execute']);
    expect(execute).toHaveBeenCalledExactlyOnceWith(id, INPUT, ctx);
  });

  it.each(UNPRICED)('%s forwards input and invocation without seeding', async (id) => {
    const { executeLazyCommand } = await import('./lazy-dispatch.js');
    const seed = vi.fn(() => Promise.resolve());
    const ctx = context(seed);
    await expect(executeLazyCommand(id, INPUT, ctx)).resolves.toBe(0);
    expect(seed).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledExactlyOnceWith(id, INPUT, ctx);
  });

  it.each(['cassette.json', ''])(
    'agent fixture string %j skips the external file seed',
    async (fixture) => {
      const { executeLazyCommand } = await import('./lazy-dispatch.js');
      const seed = vi.fn(() => Promise.resolve());
      await executeLazyCommand('agent.run', { ...INPUT, options: { fixture } }, context(seed));
      expect(seed).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false, ['cassette.json'], undefined])(
    'non-string fixture %j does not bypass seeding',
    async (fixture) => {
      const { executeLazyCommand } = await import('./lazy-dispatch.js');
      const seed = vi.fn(() => Promise.resolve());
      await executeLazyCommand('agent.run', { ...INPUT, options: { fixture } }, context(seed));
      expect(seed).toHaveBeenCalledTimes(1);
    },
  );

  it('two priced routes sharing an invocation cannot reseed after the first runtime', async () => {
    const { executeLazyCommand } = await import('./lazy-dispatch.js');
    const load = vi.fn(() => {
      events.push('file');
    });
    const ctx = context(createFileCatalogSeed(load));
    await executeLazyCommand('chat', INPUT, ctx);
    await executeLazyCommand('chat-resume', INPUT, ctx);
    expect(load).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['file', 'import runtime', 'execute', 'execute']);
    expect(execute.mock.calls.every((call) => call[2].invocation === ctx.invocation)).toBe(true);
  });

  it.each(['../dispatch.js', 'constructor', 'toString', 'unknown'])(
    'rejects unknown id %s before seed or import',
    async (id) => {
      const { executeLazyCommand } = await import('./lazy-dispatch.js');
      const seed = vi.fn(() => Promise.resolve());
      await expect(executeLazyCommand(id, INPUT, context(seed))).rejects.toMatchObject({
        code: 'invalid_invocation',
      });
      expect(seed).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    },
  );

  it.each(['run', 'models', 'provider.list', 'media.prune-temporaries'])(
    '%s refuses unsupported FS grants before seed or import',
    async (id) => {
      const { executeLazyCommand } = await import('./lazy-dispatch.js');
      const seed = vi.fn(() => Promise.resolve());
      const ctx = context(seed);
      await expect(
        executeLazyCommand(id, INPUT, {
          ...ctx,
          global: { ...ctx.global, allowFsRoots: ['/admitted-but-unsupported'] },
        }),
      ).rejects.toMatchObject({ code: 'invalid_invocation' });
      expect(seed).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    },
  );

  it('valid media maintenance imports only media and never seeds', async () => {
    const { executeLazyCommand } = await import('./lazy-dispatch.js');
    const seed = vi.fn(() => Promise.resolve());
    const ctx = context(seed);
    await executeLazyCommand(
      'media.prune-temporaries',
      {
        positionals: [],
        options: { legacyOffline: true, force: true },
      },
      ctx,
    );
    expect(events).toEqual(['import media']);
    expect(media).toHaveBeenCalledExactlyOnceWith({ legacyOffline: true, force: true }, ctx);
    expect(seed).not.toHaveBeenCalled();
  });

  it.each([
    { positionals: [], options: {} },
    { positionals: [], options: { legacyOffline: true } },
    { positionals: [], options: { legacyOffline: 'true', force: true } },
    { positionals: ['unexpected'], options: { legacyOffline: true, force: true } },
  ])('invalid media maintenance refuses before any runtime import: %j', async (input) => {
    const { executeLazyCommand } = await import('./lazy-dispatch.js');
    const seed = vi.fn(() => Promise.resolve());
    await expect(
      executeLazyCommand('media.prune-temporaries', input, context(seed)),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(events).toEqual([]);
    expect(seed).not.toHaveBeenCalled();
  });
});
