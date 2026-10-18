import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = fileURLToPath(
  new URL('./fixtures/workflow-cleanup-register.mjs', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('../secrets/fixtures/native-close-child.ts', import.meta.url),
);

describe('shipping one-shot agent input close custody', () => {
  it.each(['eof', 'factory', 'cancel', 'predestroyed'] as const)(
    '%s keeps its actual invocation until native pipe close delivery',
    async (action) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-agent-close-'));
      writeFileSync(join(root, 'config.toml'), '');
      const child = spawn(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-transform-types',
          '--import',
          register,
          fixture,
          `agent-${action}`,
          root,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, HOME: root, USERPROFILE: root },
        },
      );
      let stdout = '',
        stderr = '',
        watchdogFired = false;
      let releaseFailure: Error | null = null;
      const messages: unknown[] = [];
      child.stdin?.on('error', () => {});
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
          child.send('release', (error) => {
            releaseFailure = error;
          });
      });
      const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill('SIGKILL');
      }, 10_000);
      if (action === 'eof') child.stdin?.end('synthetic prompt\n');
      try {
        const exit = await closed;
        expect(stderr, 'AGENT_STDIN_FIXTURE_INFRASTRUCTURE').toBe('');
        expect(watchdogFired).toBe(false);
        expect(messages[0], 'AGENT_INPUT_RETAINS_ACTUAL_NATIVE_CLOSE').toMatchObject({
          phase: 'held',
          delivered: false,
          settled: false,
          closed: true,
          // EOF keeps both the surface and its not-yet-built host reservation. Fatal/signal stop
          // retires the empty host first, while the surface still owes actual stdin close.
          activeOwners: action === 'eof' ? 2 : 1,
        });
        expect(releaseFailure, 'AGENT_STDIN_FIXTURE_RELEASE_DELIVERY').toBeNull();
        expect(exit).toEqual({
          code: action === 'eof' ? 0 : action === 'cancel' ? 143 : 9,
          signal: null,
        });
        if (action === 'eof') {
          expect(stdout).toBe('');
          expect(messages).toHaveLength(2);
          expect(messages[1]).toMatchObject({
            phase: 'settled',
            delivered: true,
            settled: true,
            activeOwners: 0,
            result: { code: 'invalid_invocation', exitCode: 2 },
          });
        } else {
          expect(messages).toHaveLength(1);
          const final: unknown = JSON.parse(stdout);
          expect(final).toMatchObject({
            phase: 'physical-exit',
            delivered: true,
            activeOwners: action === 'predestroyed' ? 1 : 0,
          });
        }
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
