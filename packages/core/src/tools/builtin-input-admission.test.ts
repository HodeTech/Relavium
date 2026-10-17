import type { EffectDispatchPort } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS } from './builtins.js';
import { ToolArgsInvalidError, ToolPolicyError } from './errors.js';
import { createToolRegistry } from './registry.js';
import type {
  ConfirmActionHook,
  EgressCapability,
  FsCapability,
  ProcessCapability,
  ToolDef,
  ToolDispatchContext,
  ToolHost,
  ToolNodeConfig,
} from './types.js';
import { createInMemoryEffectJournalStore } from '../engine/execution-host.js';

const CANARY = 'synthetic-input-private-canary';

interface Rail {
  readonly id: string;
  readonly field: string;
  readonly base: Readonly<Record<string, unknown>>;
  readonly small: unknown;
  readonly exact: unknown;
  readonly over: unknown;
}

const RAILS: readonly Rail[] = [
  {
    id: 'write_file',
    field: 'content',
    base: { path: 'out.txt', append: true },
    small: 'hello',
    exact: 'a'.repeat(8 * 1024 * 1024),
    over: CANARY + 'a'.repeat(8 * 1024 * 1024),
  },
  {
    id: 'http_request',
    field: 'body',
    base: { url: 'https://api.example/x', method: 'POST' },
    small: 'hello',
    exact: 'a'.repeat(1024 * 1024),
    over: CANARY + 'a'.repeat(1024 * 1024),
  },
  {
    id: 'git_commit',
    field: 'message',
    base: { files: ['out.txt'] },
    small: 'ordinary commit',
    exact: 'a'.repeat(16 * 1024),
    over: CANARY + 'a'.repeat(16 * 1024),
  },
  {
    id: 'run_command',
    field: 'args',
    base: { command: 'echo' },
    small: ['--mode', 'two words', ''],
    exact: Array<string>(4).fill('a'.repeat(16 * 1024)),
    over: [CANARY + 'a'.repeat(16 * 1024)],
  },
];

function builtin(id: string): ToolDef {
  const found = BUILTIN_TOOLS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing built-in fixture: ${id}`);
  return found;
}

function harness(
  rail: Rail,
  effective: Readonly<Record<string, unknown>>,
  config: ToolNodeConfig = {},
) {
  const sequence: string[] = [];
  const original = builtin(rail.id);
  const parseArgs = vi.fn<ToolDef['parseArgs']>((raw) => {
    sequence.push('parse');
    return original.parseArgs(raw);
  });
  // git_commit has no production target; the {} probe observes the same registry timing without
  // granting command/domain authority or replacing the actual target on the other three rails.
  const policyTarget = vi.fn<NonNullable<ToolDef['policyTarget']>>((args) => {
    sequence.push('target');
    return original.policyTarget?.(args) ?? {};
  });
  const effect = vi.fn<NonNullable<ToolDef['effect']>>((args) => {
    sequence.push('effect');
    return original.effect?.(args);
  });
  const def: ToolDef = { ...original, parseArgs, policyTarget, effect };
  const store = createInMemoryEffectJournalStore();
  const port = store.for({ kind: 'run', runId: 'r-bounds', nodeId: 'n-bounds', attempt: 1 });
  const prepare = vi.fn<EffectDispatchPort['prepare']>((...args) => {
    sequence.push('prepare');
    return port.prepare(...args);
  });
  const settle = vi.fn<EffectDispatchPort['settle']>((...args) => {
    sequence.push('settle');
    return port.settle(...args);
  });
  const discard = vi.fn<EffectDispatchPort['discard']>((...args) => port.discard(...args));
  const writeFile = vi.fn<FsCapability['writeFile']>((path, data) => {
    sequence.push('host');
    return Promise.resolve({ path, bytesWritten: data.length });
  });
  const spawn = vi.fn<ProcessCapability['spawn']>(() => {
    sequence.push('host');
    return Promise.resolve({ exitCode: 0, stdout: 'done', stderr: '', durationMs: 1 });
  });
  const fetch = vi.fn<EgressCapability['fetch']>(() => {
    sequence.push('host');
    return Promise.resolve({ status: 200, headers: {}, body: 'done' });
  });
  const host: ToolHost = {
    fs: {
      readFile: () =>
        Promise.resolve({ content: '', mimeType: 'text/plain', sizeBytes: 0, lastModified: 't' }),
      listDirectory: () => Promise.resolve({ entries: [] }),
      writeFile,
    },
    process: { spawn },
    egress: { fetch },
  };
  const confirm = vi.fn<ConfirmActionHook>(() => {
    sequence.push('confirm');
    return Promise.resolve({ outcome: 'approve' });
  });
  const emitApprovalRequested = vi.fn(() => {
    sequence.push('approval_event');
  });
  const beforeDispatch = vi.fn(() => {
    sequence.push('before');
  });
  const args = effective['args'];
  const command = effective['command'];
  const vector =
    Array.isArray(args) && args.every((value): value is string => typeof value === 'string')
      ? args
      : [];
  const ctx: ToolDispatchContext = {
    nodeId: 'n-bounds',
    grantedToolIds: new Set([rail.id]),
    config,
    toolPolicy: {
      allowedDomains: ['api.example'],
      allowedCommands: [[typeof command === 'string' ? command : 'echo', ...vector].join(' ')],
    },
    fsScope: 'sandboxed',
    gateApproved: true,
    effects: { prepare, settle, discard },
    effectSlot: 0,
    approval: { confirm, emitApprovalRequested },
    beforeDispatch,
  };
  const registry = createToolRegistry({ tools: [def], host });
  const dispatch = (modelArgs: unknown, overrides: Partial<ToolDispatchContext> = {}) =>
    registry.dispatch(
      { type: 'tool_call', id: 'c-bounds', name: rail.id, args: modelArgs },
      { ...ctx, ...overrides },
    );
  return {
    dispatch,
    sequence,
    parseArgs,
    policyTarget,
    effect,
    confirm,
    emitApprovalRequested,
    prepare,
    settle,
    discard,
    beforeDispatch,
    writeFile,
    spawn,
    fetch,
    store,
  };
}

type Harness = ReturnType<typeof harness>;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectRefusal(error: unknown, field: string, h: Harness): void {
  expect(error, '[ADMISSION-TYPED] bound refusal is an argument validation failure').toBeInstanceOf(
    ToolArgsInvalidError,
  );
  if (!(error instanceof ToolArgsInvalidError)) return;
  expect(error).toMatchObject({
    code: 'invalid_args',
    runErrorCode: 'validation',
    retryable: false,
  });
  expect(error.fields, '[ADMISSION-FIELD] public diagnostic names the offending path').toContain(
    field,
  );
  expect(
    error.message,
    '[ADMISSION-PRIVACY] public message contains no input canary',
  ).not.toContain(CANARY);
  expect(
    JSON.stringify(error),
    '[ADMISSION-PRIVACY] enumerable public diagnostic contains no input canary',
  ).not.toContain(CANARY);
  // The native private cause is deliberately not a universal public secrecy claim.
  expect(
    h.sequence,
    '[ADMISSION-ORDER] parse refusal precedes target, policy, approval and effects',
  ).toEqual(['parse']);
  for (const spy of [
    h.policyTarget,
    h.effect,
    h.confirm,
    h.emitApprovalRequested,
    h.prepare,
    h.settle,
    h.discard,
    h.beforeDispatch,
    h.writeFile,
    h.spawn,
    h.fetch,
  ]) {
    expect(spy, '[ADMISSION-ZERO] no downstream rail is touched on refusal').not.toHaveBeenCalled();
  }
  expect(h.store.rows()).toEqual([]);
}

function expectHostValue(rail: Rail, value: unknown, h: Harness): void {
  if (rail.id === 'write_file')
    expect(h.writeFile.mock.calls[0]?.slice(0, 3)).toEqual([
      'out.txt',
      value,
      { append: true, createDirs: undefined },
    ]);
  if (rail.id === 'http_request')
    expect(h.fetch.mock.calls[0]?.[0]).toEqual({
      method: 'POST',
      url: 'https://api.example/x',
      headers: undefined,
      body: value,
    });
  if (rail.id === 'run_command')
    expect(h.spawn.mock.calls[0]?.slice(0, 2)).toEqual(['echo', value]);
  if (rail.id === 'git_commit')
    expect(h.spawn.mock.calls[0]?.slice(0, 2)).toEqual([
      'git',
      ['commit', '-m', value, '--', 'out.txt'],
    ]);
}

function expectCommitted(rail: Rail, value: unknown, h: Harness): void {
  const approval = rail.id === 'git_commit' ? [] : ['approval_event', 'confirm'];
  expect(h.sequence, '[POSITIVE-RAIL] accepted effective args reach the real ordered rail').toEqual(
    ['parse', 'target', 'effect', ...approval, 'prepare', 'before', 'host', 'settle'],
  );
  expect(h.prepare).toHaveBeenCalledOnce();
  expect(h.settle).toHaveBeenCalledWith(0, rail.id, 'committed', expect.anything());
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.store.rows()).toMatchObject([{ toolId: rail.id, state: 'committed', tier: 3 }]);
  expectHostValue(rail, value, h);
}

describe('built-in bounds at effective-argument admission before money/effects', () => {
  for (const rail of RAILS) {
    for (const [label, value] of [
      ['small', rail.small],
      ['exact-cap', rail.exact],
    ]) {
      it(`[POSITIVE-RAIL] ${rail.id} ${String(label)} reaches approval/journal/host unchanged`, async () => {
        const effective = { ...rail.base, [rail.field]: value };
        const h = harness(rail, effective);
        await h.dispatch(effective);
        expectCommitted(rail, value, h);
      });
    }

    for (const source of ['model', 'mapping-over-model', 'mapping-without-model']) {
      it(`[EFFECTIVE-REFUSAL] ${rail.id} refuses oversized ${source} before every downstream rail`, async () => {
        const effective = { ...rail.base, [rail.field]: rail.over };
        const config: ToolNodeConfig = source === 'model' ? {} : { inputMapping: effective };
        const h = harness(rail, effective, config);
        const model =
          source === 'model'
            ? effective
            : source === 'mapping-over-model'
              ? { ...rail.base, [rail.field]: rail.small }
              : undefined;
        const error = await rejection(h.dispatch(model));
        expectRefusal(error, rail.id === 'run_command' ? 'args.0' : rail.field, h);
      });
    }

    it(`[EFFECTIVE-OVERRIDE] ${rail.id} valid mapping replaces oversized model value before admission`, async () => {
      const effective = { ...rail.base, [rail.field]: rail.small };
      const h = harness(rail, effective, { inputMapping: effective });
      await h.dispatch({ ...rail.base, [rail.field]: rail.over });
      expectCommitted(rail, rail.small, h);
    });

    it(`[CONFIG-EXCLUSION] ${rail.id} parameters do not override model-visible bounded fields`, async () => {
      const effective = { ...rail.base, [rail.field]: rail.small };
      const h = harness(rail, effective, { parameters: { [rail.field]: rail.over } });
      await h.dispatch(effective);
      expectCommitted(rail, rail.small, h);
    });
  }

  for (const [label, args] of [
    ['count', Array<string>(257).fill('')],
    ['aggregate', [...Array<string>(4).fill('a'.repeat(16 * 1024)), 'a']],
  ] satisfies Array<[string, string[]]>) {
    it(`[ARG-VECTOR-ADMISSION] run_command refuses ${label} before target and preparation`, async () => {
      const rail = RAILS.find((candidate) => candidate.id === 'run_command');
      if (rail === undefined) throw new Error('missing command rail');
      const effective = { command: 'echo', args };
      const h = harness(rail, effective);
      expectRefusal(await rejection(h.dispatch(effective)), 'args', h);
    });
  }

  it('[GIT-GATE-PRESERVATION] valid git args still require a gate and invalid args precede gate denial', async () => {
    const rail = RAILS.find((candidate) => candidate.id === 'git_commit');
    if (rail === undefined) throw new Error('missing commit rail');
    const effective = { ...rail.base, message: rail.small };
    const h = harness(rail, effective);
    const gateError = await rejection(h.dispatch(effective, { gateApproved: false }));
    expect(gateError).toBeInstanceOf(ToolPolicyError);
    expect(gateError).toMatchObject({ code: 'tool_denied', reason: 'gate_required' });
    expect(h.prepare).not.toHaveBeenCalled();
    const invalid = harness(rail, effective);
    expectRefusal(
      await rejection(
        invalid.dispatch({ ...rail.base, message: rail.over }, { gateApproved: false }),
      ),
      'message',
      invalid,
    );
  });

  it('[UNJOURNALED-POSITIVES] overwrite and omitted-body GET reach host without effect preparation', async () => {
    const write = RAILS[0];
    const http = RAILS[1];
    if (write === undefined || http === undefined) throw new Error('missing non-effect rails');
    const w = harness(write, { path: 'out.txt', content: '' });
    await w.dispatch({ path: 'out.txt', content: '' });
    expect(w.writeFile).toHaveBeenCalledOnce();
    expect(w.beforeDispatch).toHaveBeenCalledOnce();
    expect(w.confirm).toHaveBeenCalledOnce();
    expect(w.store.rows()).toEqual([]);
    expect(w.prepare).not.toHaveBeenCalled();
    const h = harness(http, { url: 'https://api.example/x' });
    await h.dispatch({ url: 'https://api.example/x' });
    expect(h.fetch.mock.calls[0]?.[0]).toEqual({
      method: 'GET',
      url: 'https://api.example/x',
      headers: undefined,
      body: undefined,
    });
    expect(h.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.store.rows()).toEqual([]);
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
