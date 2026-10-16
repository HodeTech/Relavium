import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from './process/cli-error.js';
import { createCliInvocation, type CliInvocation } from './process/invocation.js';
import type { CliIo } from './process/io.js';
import type { ExitCode } from './process/exit-codes.js';
import { run } from './run.js';

const state = vi.hoisted(() => {
  const trace: string[] = [];
  const invocation: unknown = undefined;
  return { trace, refuse: false, invocation };
});
vi.mock('./engine/tool-host/fs-invocation-admission.js', () => ({
  admitFsInvocation: () => {
    state.trace.push('admission');
    if (state.refuse)
      throw new CliError('invalid_invocation', 'Synthetic directory admission refused.');
    return Object.freeze({ kind: 'invocation-fs-grants' });
  },
}));
vi.mock('./commands/dispatch.js', () => ({
  executeCommand: (_id: string, _input: unknown, ctx: { invocation?: CliInvocation }) => {
    state.trace.push('dispatch');
    state.invocation = ctx.invocation;
    return Promise.resolve(0);
  },
}));

function fixture(interactive = false) {
  let out = '';
  let err = '';
  const io: CliIo = {
    writeOut: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
    writeErrAcknowledged: (text) => {
      err += text;
      return Promise.resolve();
    },
    env: {},
    stdoutIsTty: interactive,
    stdinIsTty: interactive,
    stdin: Readable.from([]),
  };
  const base = createCliInvocation();
  const invocation: CliInvocation = Object.freeze({
    registry: base.registry,
    seedFileCatalogOnce: () => {
      state.trace.push('seed');
      return Promise.resolve();
    },
  });
  return { io, invocation, out: () => out, err: () => err };
}
const argv = (...tokens: string[]) => ['node', 'relavium', ...tokens];

beforeEach(() => {
  state.trace.length = 0;
  state.refuse = false;
  state.invocation = undefined;
});

describe('lazy run boundary with injected admission/runtime observers', () => {
  it.each(
    [
      [],
      ['--help'],
      ['--version'],
      ['run', '--help'],
      ['agent', '--help'],
      ['provider', '--help'],
      ['chat', '--help'],
      ['--json', '--help'],
      ['--allow-fs-root', resolve('/synthetic-missing-directory'), '--help'],
      ['run', '--allow-fs-root', resolve('/synthetic-missing-directory'), '--help'],
    ].map((tokens) => ({ tokens })),
  )(
    'keeps meta grammar $tokens before directory admission, catalog or dispatch',
    async ({ tokens }) => {
      const f = fixture();
      expect(await run(argv(...tokens), f.io, undefined, f.invocation)).toBe(0);
      expect(f.out().length).toBeGreaterThan(0);
      expect(f.err()).toBe('');
      expect(state.trace).toEqual([]);
    },
  );

  it.each(
    [
      ['--allow-fs-root', 'relative-root', '--help'],
      ['--allow-fs-root', '--help'],
      ['--verbose', '--quiet', '--help'],
      ['run'],
    ].map((tokens) => ({ tokens })),
  )('refuses invalid grammar $tokens before services', async ({ tokens }) => {
    const f = fixture();
    expect(await run(argv(...tokens), f.io, undefined, f.invocation)).toBe(2);
    expect(f.err().length).toBeGreaterThan(0);
    expect(state.trace).toEqual([]);
  });

  it('preserves one invocation object through admission, seed and the real lazy route', async () => {
    const f = fixture();
    expect(await run(argv('run', 'synthetic.workflow.yaml'), f.io, undefined, f.invocation)).toBe(
      0,
    );
    expect(state.trace).toEqual(['admission', 'seed', 'dispatch']);
    expect(state.invocation).toBe(f.invocation);
    expect(f.err()).toBe('');
  });

  it('refuses a real-action admission before even the optional cache or runtime action', async () => {
    const f = fixture();
    state.refuse = true;
    expect(await run(argv('chat'), f.io, undefined, f.invocation)).toBe(2);
    expect(state.trace).toEqual(['admission']);
    expect(f.err()).toContain('Synthetic directory admission refused.');
  });

  it('threads the same invocation into the injected interactive Home boundary after admission and seed', async () => {
    const f = fixture(true);
    const open = vi.fn((deps: { invocation?: CliInvocation }): Promise<ExitCode> => {
      state.trace.push('home');
      expect(deps.invocation).toBe(f.invocation);
      return Promise.resolve(4);
    });
    expect(await run(argv(), f.io, open, f.invocation)).toBe(4);
    expect(state.trace).toEqual(['admission', 'seed', 'home']);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
