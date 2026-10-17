import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo, OwnedTtyOutput } from '../test-support.js';
import { runSessionPrompt } from '../chat/session-prompt.js';
import { createBoundOnboardingPrompter } from './wizard.js';

describe('installed onboarding prompts on captured invocation streams', () => {
  it.each(['select', 'password'] as const)(
    '%s releases captured native listeners on original host stop',
    async (kind) => {
      const f = invocationFixture();
      const input = new PassThrough();
      const output = new OwnedTtyOutput();
      const captured = captureIo();
      const parent = new AbortController();
      const io = { ...captured.io, stdin: input, nativeStdout: output };
      const prompt = createBoundOnboardingPrompter(io);
      expect(prompt.spinner).toBeUndefined(); // Installed spinner would silently borrow ambient stdin.
      const answer = runSessionPrompt(
        f.invocation,
        io,
        () => f.registry.assertAdmitting(),
        () => f.invocation.finiteExit.fail('cli_internal'),
        (signal) =>
          kind === 'select'
            ? prompt.select({
                message: 'Synthetic provider',
                options: [{ value: 'synthetic', label: 'Synthetic' }],
                signal,
              })
            : prompt.password({ message: 'Synthetic hidden input', signal }),
        parent.signal,
      );
      try {
        expect(input.listenerCount('keypress')).toBeGreaterThan(0);
        expect(output.frames.join('')).toContain('Synthetic');
        parent.abort();
        expect(typeof (await answer)).toBe('symbol');
        expect(input.listenerCount('keypress'), 'ONBOARDING_CAPTURED_PROMPT_NATIVE_RELEASE').toBe(
          0,
        );
        expect(output.listenerCount('resize')).toBe(0);
        expect(f.registry.activeOwners).toBe(0);
        expect(f.exit).not.toHaveBeenCalled();
      } finally {
        input.destroy();
        output.destroy();
      }
    },
  );
});
