import { describe, expect, it } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CommandLifetime } from '../process/command-lifetime.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { createCommand } from '../commands/create.js';
import { acknowledgeWrite } from '../process/io.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import { tmpdir } from 'node:os';

describe('installed create wizard prompt ownership', () => {
  it('uses captured input and releases it before command retirement on stop', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const { io } = captureIo();
    const lifetime = new CommandLifetime(
      f.invocation,
      {
        ...io,
        stdoutIsTty: true,
        stdinIsTty: true,
        stdin: input,
        nativeStdin: input,
        nativeStdout: output,
        writeOutAcknowledged: (text) => acknowledgeWrite(output, text),
      },
      () => () => undefined,
    );
    const wizard = lifetime.execute(() =>
      createCommand(
        { force: false },
        {
          io: lifetime.io,
          commandLifetime: lifetime,
          global: {
            json: false,
            color: false,
            cwd: tmpdir(),
            configPath: undefined,
            verbosity: 'normal',
          },
        },
      ),
    );
    try {
      expect(output.frames.join('')).toContain('Create a');
      expect(input.listenerCount('keypress')).toBeGreaterThan(0);
      f.invocation.finiteExit.signal(15);
      await wizard;
      expect(
        input.listenerCount('keypress'),
        'CREATE_PROMPT_NATIVE_RELEASE_PRECEDES_RETIREMENT',
      ).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(input.isRaw).toBe(false);
      expect(output.frames.join('')).toContain(SHOW_CURSOR);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode()).toBe(143);
    } finally {
      input.destroy();
      output.destroy();
    }
  });
});
