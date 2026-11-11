import { describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../program.js';
import { captureIo } from '../test-support.js';
import type { DispatchCommand } from './input.js';

const invocations: readonly (readonly string[])[] = [
  ['run', 'workflow'],
  ['chat'],
  ['chat-resume', 'session'],
  ['chat', 'resume', 'session'],
  ['chat-list'],
  ['chat', 'list'],
  ['chat-export', 'session', '--out', 'copy.yaml'],
  ['create'],
  ['import', 'file.yaml'],
  ['export', 'workflow', '--out', 'copy.yaml'],
  ['agent', 'run', 'helper'],
  ['gate', 'run-id'],
  ['gate', 'list', 'run-id'],
  ['budget', 'resume', 'run-id', '--abort'],
  ['list'],
  ['logs', 'run-id'],
  ['status', 'run-id'],
  ['init'],
  ['models'],
  ['models', 'refresh'],
  ['models', 'pricing', 'model', '--provider', 'openai'],
  ['provider', 'list'],
  ['provider', 'add', 'openai'],
  ['provider', 'set-key', 'openai'],
  ['provider', 'remove-key', 'openai'],
  ['provider', 'test', 'openai'],
  ['media', 'prune-temporaries'],
];

describe('MVP-2 invalid positional grammar', () => {
  it.each(invocations.map((argv) => ({ argv })))(
    'refuses extra values before dispatch: $argv',
    async ({ argv }) => {
      const { io, err } = captureIo();
      const execute = vi.fn<DispatchCommand>(() => Promise.resolve(0));
      const program = buildProgram(io, {
        execute,
        context: {
          io,
          global: {
            cwd: '/test',
            configPath: undefined,
            color: false,
            json: false,
            verbosity: 'normal',
          },
          result: {},
        },
      });
      const poison = 'opaque-argument-should-never-be-reflected';
      await expect(
        program.parseAsync(['node', 'relavium', ...argv, '--', poison]),
      ).rejects.toMatchObject({
        code: 'commander.excessArguments',
      });
      expect(execute).not.toHaveBeenCalled();
      expect(err()).not.toContain(poison);
    },
  );

  it('retains variadic option values instead of treating them as excess positionals', async () => {
    const { io } = captureIo();
    const execute = vi.fn<DispatchCommand>(() => Promise.resolve(0));
    const program = buildProgram(io, {
      execute,
      context: {
        io,
        global: {
          cwd: '/test',
          configPath: undefined,
          color: false,
          json: false,
          verbosity: 'normal',
        },
        result: {},
      },
    });
    await program.parseAsync(['node', 'relavium', 'run', 'workflow', '--input', 'a=1', 'b=2']);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].options['input']).toEqual(['a=1', 'b=2']);
  });
});
