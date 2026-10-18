import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = fileURLToPath(
  new URL('./fixtures/workflow-cleanup-register.mjs', import.meta.url),
);
const fixture = fileURLToPath(new URL('./fixtures/active-agent-signal-child.ts', import.meta.url));
const modes = [
  'chat-plain',
  'chat-json',
  'resume-plain',
  'resume-json',
  'agent-plain',
  'agent-json',
  'chat-eof-plain',
  'chat-eof-json',
];

// Windows child.kill(SIGINT) forcibly terminates instead of delivering a cooperative OS signal.
// Existing portable listener/native-owner units cover Windows; these cases claim POSIX OS delivery only.
describe.skipIf(process.platform === 'win32')(
  'shipping agent surfaces retain active shutdown ACKs',
  () => {
    it.each(modes)(
      '%s joins provider and actual MCP native close ACKs',
      async (mode) => {
        const eof = mode.includes('-eof-');
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-active-signal-')));
        const child = spawn(
          process.execPath,
          [
            '--no-warnings',
            '--experimental-transform-types',
            '--import',
            register,
            fixture,
            mode,
            root,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, HOME: root, USERPROFILE: root },
          },
        );
        const messages: unknown[] = [];
        const phases: string[] = [];
        const deliveryErrors: Error[] = [];
        let stdout = '';
        let stderr = '';
        let watchdogFired = false;
        let releasedNative = false;
        let nativePid: number | undefined;
        let confirmedNativeClose = false;
        const send = (message: string): void => {
          child.send(message, (error) => {
            if (error !== null) deliveryErrors.push(error);
          });
        };
        child.stdin?.on('error', () => {});
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('message', (message: unknown) => {
          messages.push(message);
          const phase: unknown =
            typeof message === 'object' && message !== null
              ? Object.getOwnPropertyDescriptor(message, 'phase')?.value
              : undefined;
          if (typeof phase !== 'string') return;
          phases.push(phase);
          const pid: unknown = Object.getOwnPropertyDescriptor(message, 'nativePid')?.value;
          if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) nativePid = pid;
          if (phase === 'provider-active') {
            if (eof) {
              child.stdin?.end();
              send('release-provider');
            } else child.kill('SIGINT');
          }
          if (phase === 'provider-abort-held') send('release-provider');
          // Both deliveries are independently held. Native close can race provider shutdown.
          if (
            !releasedNative &&
            phases.includes('provider-ack') &&
            phases.includes('native-close-held')
          ) {
            releasedNative = true;
            send('release-native');
          }
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
          },
        );
        const watchdog = setTimeout(() => {
          watchdogFired = true;
          child.kill('SIGKILL');
        }, 9000);
        if (mode.startsWith('agent-')) child.stdin?.end('synthetic active prompt\n');
        else child.stdin?.write('synthetic active prompt\n');
        try {
          const exit = await closed;
          expect(stderr, 'ACTIVE_SIGNAL_FIXTURE_INFRASTRUCTURE').toBe('');
          expect(stdout, 'ACTIVE_SIGNAL_FIXTURE_STDOUT_ISOLATION').toBe('');
          expect(watchdogFired, JSON.stringify(messages)).toBe(false);
          expect(deliveryErrors).toEqual([]);
          expect(phases[0], 'ACTIVE_PROVIDER_PRECEDES_OS_SIGNAL').toBe('provider-active');
          if (!eof) expect(phases).toContain('provider-abort-held');
          expect(phases).toContain('provider-ack');
          expect(phases).toContain('native-close-held');
          const witness = (phase: string) => messages[phases.indexOf(phase)];
          expect(witness('provider-active')).toMatchObject({
            providerAborted: false,
            providerAcknowledged: false,
            nativeAcknowledged: false,
            settled: false,
          });
          if (!eof)
            expect(
              witness('provider-abort-held'),
              'ABORT_REQUEST_IS_NOT_PROVIDER_ACK',
            ).toMatchObject({
              providerAborted: true,
              providerAcknowledged: false,
              settled: false,
            });
          expect(
            witness('native-close-held'),
            'NATIVE_EXIT_IS_NOT_NATIVE_CLOSE_DELIVERY',
          ).toMatchObject({
            nativeCloseHeld: true,
            nativeCloseDelivered: false,
            nativeAcknowledged: false,
            settled: false,
          });
          for (const phase of eof
            ? ['native-close-held']
            : ['provider-abort-held', 'native-close-held']) {
            const message = witness(phase);
            const count: unknown =
              typeof message === 'object' && message !== null
                ? Object.getOwnPropertyDescriptor(message, 'activeOwners')?.value
                : undefined;
            expect(count, 'ACTUAL_WORK_RETAINS_ORIGINAL_INVOCATION').toBeGreaterThan(0);
          }
          expect(exit).toEqual({ code: mode.startsWith('agent-') ? 130 : 4, signal: null });
          const final: unknown = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'));
          expect(final, 'PHYSICAL_EXIT_REQUIRES_BOTH_ACTUAL_ACKS').toMatchObject({
            providerAborted: !eof,
            providerAcknowledged: true,
            nativeCloseHeld: true,
            nativeCloseDelivered: true,
            nativeAcknowledged: true,
            activeOwners: 0,
            stderr: '',
          });
          confirmedNativeClose = true;
          if (!mode.startsWith('agent-')) {
            expect(phases.at(-1)).toBe('settled');
            expect(final).toMatchObject({ settled: true, result: 4 });
          }
        } finally {
          clearTimeout(watchdog);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await closed;
          if (!confirmedNativeClose && nativePid !== undefined) {
            try {
              process.kill(nativePid, 'SIGKILL');
            } catch {
              /* Actual child already gone. */
            }
          }
          rmSync(root, { recursive: true, force: true });
        }
      },
      10000,
    );
  },
);
