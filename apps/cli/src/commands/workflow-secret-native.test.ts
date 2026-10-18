import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = fileURLToPath(
  new URL('./fixtures/workflow-cleanup-register.mjs', import.meta.url),
);
const fixture = fileURLToPath(new URL('./fixtures/workflow-secret-child.ts', import.meta.url));

describe('default workflow secret reader owns captured native input', () => {
  it.each(['run', 'gate'] as const)(
    '%s closes its open pipe on first Ctrl-C before command/DB retirement',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-workflow-secret-'));
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--experimental-strip-types', '--import', register, fixture, mode, root],
        {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, HOME: root, USERPROFILE: root },
        },
      );
      let stdout = '',
        stderr = '',
        watchdogFired = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const messages: unknown[] = [];
      child.on('message', (message: unknown) => {
        messages.push(message);
        if (
          typeof message === 'object' &&
          message !== null &&
          Object.getOwnPropertyDescriptor(message, 'type')?.value === 'ready'
        ) {
          // Windows exercises the exact installed callback; POSIX receives an actual OS SIGINT.
          if (process.platform === 'win32') child.send({ type: 'interrupt' });
          else child.kill('SIGINT');
        }
      });
      const closed = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal })),
      );
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill('SIGKILL');
      }, 10000);
      try {
        expect(await closed, 'WORKFLOW_SECRET_NATIVE_CANCEL').toEqual({ code: 0, signal: null });
        expect(watchdogFired).toBe(false);
        expect(messages).toEqual([{ type: 'ready', source: 'captured' }]);
        expect(stdout).toBe('');
        expect(stderr).toBe('');
        const evidence: unknown = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
        expect(evidence).toEqual({
          code: 1,
          events:
            mode === 'gate'
              ? ['stdin-close', 'db-close', 'command-settled']
              : ['stdin-close', 'command-settled'],
          keyCalls: 0,
          buildCalls: 0,
          dbCloses: mode === 'gate' ? 1 : 0,
          ambientReads: 0,
          capturedClosed: true,
          ambientDestroyed: false,
          owners: 0,
          terminating: false,
          observedExit: 1,
        });
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});
