import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = fileURLToPath(
  new URL('./fixtures/workflow-cleanup-register.mjs', import.meta.url),
);
const fixture = fileURLToPath(new URL('./fixtures/workflow-cleanup-child.ts', import.meta.url));

describe('actual workflow cleanup failures behind the shared physical signal deadline', () => {
  it.each(['run-close-fault', 'gate-close-fault', 'run-build-fault', 'gate-build-fault'] as const)(
    '%s retains real SQLite and actual MCP close obligations and exits with the prior infrastructure failure',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-workflow-cleanup-'));
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--experimental-strip-types', '--import', register, fixture, mode, root],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, HOME: root, USERPROFILE: root },
        },
      );
      let stderr = '';
      let stdout = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 32768) child.kill('SIGKILL');
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 32768) child.kill('SIGKILL');
      });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      );
      let reportPremature = (): void => undefined;
      const premature = new Promise<void>((resolve) => {
        reportPremature = resolve;
      });
      const messages: string[] = [];
      child.on('message', (message: unknown) => {
        const type: unknown =
          typeof message === 'object' && message !== null
            ? Object.getOwnPropertyDescriptor(message, 'type')?.value
            : undefined;
        if (typeof type !== 'string') return;
        messages.push(type);
        if (type === 'unexpected-settlement') reportPremature();
        if (type === 'ready') child.send({ type: 'go' });
        if (type === 'cleanup-entered') {
          // Windows does not deliver POSIX SIGTERM: enter the exact registered signal callback there.
          // POSIX legs deliver the real OS signal after observing actual connection-close entry.
          if (process.platform === 'win32') child.send({ type: 'terminate' });
          else child.kill('SIGTERM');
        }
      });
      let watchdogFired = false;
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill('SIGKILL');
      }, 9000);
      try {
        const result = await Promise.race([
          closed.then((exit) => ({ kind: 'closed' as const, exit })),
          premature.then(() => ({ kind: 'premature' as const })),
        ]);
        expect(watchdogFired, stderr).toBe(false);
        expect(messages.slice(0, 2), stderr).toEqual(['ready', 'cleanup-entered']);
        expect(stdout).toBe('');
        expect(stderr).toBe(''); // Runtime/setup/native-child contamination cannot supply the semantic witness.
        // Premature command settlement is the semantic failure itself. The finally below joins
        // this already-owned fixture; its watchdog/kill can never supply the acceptance witness.
        expect(result, 'WORKFLOW_NATIVE_CLOSE_ACK').toEqual({
          kind: 'closed',
          exit: { code: 9, signal: null },
        });
        expect(messages, stderr).toEqual(['ready', 'cleanup-entered']);
        const witness: unknown = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'));
        expect(witness).toMatchObject({
          dbOpen: true,
          dbCloseCount: 0,
          closeCount: 1,
          settled: false,
          observedExit: 9,
        });
        const elapsed: unknown =
          typeof witness === 'object' && witness !== null
            ? Object.getOwnPropertyDescriptor(witness, 'elapsed')?.value
            : undefined;
        expect(elapsed).toBeGreaterThanOrEqual(2700);
        expect(elapsed).toBeLessThan(4500);
        expect(stdout).toBe('');
        expect(stderr).toBe('');
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        rmSync(root, { recursive: true, force: true });
      }
    },
    12000,
  );
});
