import { PassThrough } from 'node:stream';

import { confirm } from '@clack/prompts';
import { describe, expect, it } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { runSessionPrompt } from './session-prompt.js';

describe('installed Clack session prompt release', () => {
  it('does not close a submitted installed prompt again when terminal custody finishes', async () => {
    const f = invocationFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const captured = captureIo();
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
    );
    try {
      expect(input.listenerCount('keypress')).toBeGreaterThan(0);
      input.emit('keypress', '', { name: 'return' });
      expect(await answer).toBe(true);
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
