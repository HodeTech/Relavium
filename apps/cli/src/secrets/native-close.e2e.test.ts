import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = fileURLToPath(
  new URL('../commands/fixtures/workflow-cleanup-register.mjs', import.meta.url),
);
const fixture = fileURLToPath(new URL('./fixtures/native-close-child.ts', import.meta.url));

describe('native secret input close delivery', () => {
  it.each(['factory', 'cap', 'cancel', 'predestroyed'] as const)(
    '%s grants no owner/database retirement from a public closed flag',
    async (mode) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--experimental-transform-types', '--import', register, fixture, mode],
        { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
      );
      const messages: unknown[] = [];
      let stdout = '',
        stderr = '',
        watchdogFired = false;
      child.stdin?.on('error', () => {}); // Native refusal may close the parent write side.
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('message', (message: unknown) => {
        messages.push(message);
        if (
          typeof message === 'object' &&
          message !== null &&
          Object.getOwnPropertyDescriptor(message, 'phase')?.value === 'held'
        )
          child.send('release');
      });
      const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill('SIGKILL');
      }, 10_000);
      if (mode === 'cap') child.stdin?.write(Buffer.alloc(65_537, 'x'));
      try {
        const exit = await closed;
        expect(stderr, 'NATIVE_CLOSE_CHILD_INFRASTRUCTURE').toBe('');
        expect(exit).toEqual({
          code: mode === 'cancel' ? 143 : mode === 'predestroyed' ? 9 : 0,
          signal: null,
        });
        expect(watchdogFired).toBe(false);
        expect(stderr).toBe('');
        expect(messages[0], 'SECRET_NATIVE_CLOSED_IS_NOT_DELIVERED_CLOSE').toEqual({
          phase: 'held',
          mode,
          delivered: false,
          settled: false,
          cleaned: false,
          closed: true,
          activeOwners: 1,
        });
        if (mode === 'cancel' || mode === 'predestroyed') {
          expect(messages).toHaveLength(1);
          const final: unknown = JSON.parse(stdout);
          expect(final).toMatchObject({
            phase: 'physical-exit',
            delivered: true,
            cleaned: mode === 'cancel',
            activeOwners: mode === 'cancel' ? 0 : 1,
          });
        } else {
          expect(stdout).toBe('');
          expect(messages[1]).toMatchObject({
            phase: 'settled',
            delivered: true,
            settled: true,
            cleaned: true,
            activeOwners: 0,
            result: { code: 'invalid_invocation', exitCode: 2 },
          });
          expect(messages).toHaveLength(2);
        }
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
    },
    15_000,
  );
});
