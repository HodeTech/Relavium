import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../program.js';
import { captureIo } from '../test-support.js';
import type { CommandInput } from './input.js';

function fixture(interactive = false) {
  const captured = captureIo();
  const execute = vi.fn<(id: string, input: CommandInput) => Promise<0>>(() => Promise.resolve(0));
  const context = {
    io: { ...captured.io, stdoutIsTty: interactive, stdinIsTty: interactive },
    global: {
      cwd: '/workspace',
      configPath: undefined,
      json: false,
      color: false,
      verbosity: 'normal' as const,
    },
    result: {},
  };
  return { execute, program: buildProgram(context.io, { context, execute }) };
}
describe('MVP-2 chat entry grammar before runtime dispatch', () => {
  it.each([
    ['chat', '--agent', 'a', '--continue'],
    ['chat', '--continue', '--agent', 'a'],
    ['chat', '--continue', 'resume', 'id'],
    ['chat', '--continue', 'list'],
    ['chat', '--continue', 'export', 'id'],
    ['chat', '--agent', 'a', 'resume', 'id'],
    ['chat', 'resume', 'id', '--continue'],
    ['chat', 'resume'],
    ['chat-resume'],
  ])('refuses %j before any runtime dispatch', async (...argv) => {
    const f = fixture();
    await expect(f.program.parseAsync(['node', 'relavium', ...argv])).rejects.toBeDefined();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    { argv: ['chat', 'resume', 'id'], id: 'chat-resume', positionals: ['id'] },
    { argv: ['chat-resume', 'id'], id: 'chat-resume', positionals: ['id'] },
    { argv: ['chat', 'list'], id: 'chat-list', positionals: [] },
    { argv: ['chat', 'export', 'id'], id: 'chat-export', positionals: ['id'] },
  ])('forwards $argv to its existing executor', async ({ argv, id, positionals }) => {
    const f = fixture();
    await f.program.parseAsync(['node', 'relavium', ...argv]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0]).toBe(id);
    expect(f.execute.mock.calls[0]?.[1].positionals).toEqual(positionals);
  });
  it.each([['chat', 'resume'], ['chat-resume']])(
    'allows an omitted ID only for the interactive picker: %j',
    async (...argv) => {
      const f = fixture(true);
      await f.program.parseAsync(['node', 'relavium', ...argv]);
      expect(f.execute.mock.calls[0]?.[0]).toBe('chat-resume');
      expect(f.execute.mock.calls[0]?.[1].positionals).toEqual([]);
    },
  );
});
