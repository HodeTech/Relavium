import { PassThrough } from 'node:stream';

import { confirm } from '@clack/prompts';
import { describe, expect, it, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { runSessionPrompt } from './session-prompt.js';

describe('installed Clack session prompt release', () => {
  it('a stopped host aborts the installed pending prompt and joins its actual input release', async () => {
    const f = invocationFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const parent = new AbortController();
    const answer = runSessionPrompt(
      f.invocation,
      captureIo().io,
      () => f.registry.assertAdmitting(),
      () => f.invocation.finiteExit.fail('cli_internal'),
      (signal) => confirm({ message: 'Synthetic host consent', input, output, signal }),
      parent.signal,
    );
    try {
      expect(input.listenerCount('keypress')).toBeGreaterThan(0);
      parent.abort();
      expect(typeof (await answer)).toBe('symbol');
      expect(input.listenerCount('keypress'), 'SESSION_PROMPT_PARENT_ABORT_RELEASE').toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.exit).not.toHaveBeenCalled();
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('does not enter the native prompt after its host was already stopped', async () => {
    const f = invocationFixture();
    const parent = new AbortController();
    const reason = new Error('synthetic host stop');
    parent.abort(reason);
    const native = vi.fn(() => Promise.resolve(true));
    await expect(
      runSessionPrompt(
        f.invocation,
        captureIo().io,
        () => parent.signal.throwIfAborted(),
        () => undefined,
        native,
        parent.signal,
      ),
    ).rejects.toBe(reason);
    expect(native).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('does not close a submitted installed prompt again when terminal custody finishes', async () => {
    const f = invocationFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const captured = captureIo();
    const parent = new AbortController();
    const answer = runSessionPrompt(
      f.invocation,
      {
        ...captured.io,
        stdoutIsTty: true,
        writeOutAcknowledged: (text) =>
          new Promise<void>((resolve, reject) => {
            output.write(text, (error) =>
              error === undefined || error === null ? resolve() : reject(error),
            );
          }),
      },
      () => f.registry.assertAdmitting(),
      () => f.invocation.finiteExit.fail('cli_internal'),
      (signal) =>
        confirm({
          message: 'Synthetic offline consent',
          initialValue: true,
          input,
          output,
          signal,
        }),
      parent.signal,
    );
    try {
      expect(input.listenerCount('keypress')).toBeGreaterThan(0);
      input.emit('keypress', '', { name: 'return' });
      expect(await answer).toBe(true);
      parent.abort(); // A later host shutdown must not abort an already-released installed prompt again.
      expect(
        chunks.filter((chunk) => chunk === '\n'),
        'SESSION_INSTALLED_CLACK_SINGLE_CLOSE',
      ).toHaveLength(1);
      expect(input.listenerCount('keypress')).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.exit).not.toHaveBeenCalled();
    } finally {
      input.destroy();
      output.destroy();
    }
  });
});
