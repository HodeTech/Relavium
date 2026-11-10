import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { buildResumedChatSession } from '../chat/session-host.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { chatCommand, chatResumeCommand, drivePlain } from './chat.js';

const lifecycle = {
  onInterrupt: () => () => {},
  onTerminationSignal: () => () => {},
  onProcessExit: () => () => {},
  setRawMode: () => {},
  exit: () => {},
};
const jobControlLifecycle = {
  supported: false,
  onSuspend: () => () => {},
  onContinue: () => () => {},
  suspendSelf: () => {},
};
describe.each([true, false])('actual standalone resume picker inline=%s', (inline) => {
  it.each([true, false])(
    'selects only after input or cancels without building (choose=%s)',
    async (choose) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-picker-'));
      const client = createClient(':memory:');
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      const captured = captureIo();
      const global = {
        cwd: realpathSync.native(root),
        configPath: join(root, 'absent.toml'),
        json: false,
        color: false,
        noAltScreen: inline,
        verbosity: 'normal' as const,
      };
      let n = 0;
      const stdin = new OwnedTtyInput(),
        stdout = new OwnedTtyOutput(),
        stderr = new OwnedTtyOutput();
      stdout.columns = 80;
      stdout.rows = 24;
      const f = invocationFixture();
      const close = vi.fn();
      const build = vi.fn(buildResumedChatSession);
      const keys = vi.fn(() => ({ providers: scriptedResolver([]) }));
      try {
        await chatCommand(
          { agent: undefined },
          {
            global,
            io: { ...captured.io, stdin: Readable.from(['visible seed\n/exit\n']) },
            providers: scriptedResolver([textTurn('saved answer')]),
            drive: drivePlain,
            openSessionStore: () => ({ store, db: client.db, close: () => {} }),
            uuid: () => `saved-${n++}`,
          },
        );
        const io = {
          ...captured.io,
          stdin,
          nativeStdin: stdin,
          nativeStdout: stdout,
          nativeStderr: stderr,
          stdinIsTty: true,
          stdoutIsTty: true,
          writeOutAcknowledged: (text: string) => acknowledgeWrite(stdout, text),
        };
        let entered = false;
        const running = chatResumeCommand(
          { sessionId: undefined },
          {
            global,
            io,
            invocation: f.invocation,
            lifecycle,
            jobControlLifecycle,
            resolveKeys: keys,
            buildResumedSession: build,
            openSessionStore: (_home, captureClose) => {
              captureClose?.(close);
              return { store, db: client.db, close };
            },
            drive: async (ctx) => {
              entered = true;
              expect(
                ctx.store
                  .getSnapshot()
                  .state.transcript.some((entry) => entry.text === 'visible seed'),
              ).toBe(true);
              ctx.startSession();
              await ctx.onActivated?.(() => !ctx.shouldStop());
              return { kind: 'exit' };
            },
          },
        );
        await vi.waitFor(() => expect(stdout.frames.join('')).toContain('Resume a session'));
        expect(keys).not.toHaveBeenCalled();
        expect(build).not.toHaveBeenCalled();
        stdin.push(choose ? '\r' : '\x1b');
        expect(await running).toBe(choose ? 4 : 0);
        expect(entered).toBe(choose);
        expect(build).toHaveBeenCalledTimes(choose ? 1 : 0);
        expect(close).toHaveBeenCalledTimes(1);
        expect(f.registry.activeOwners).toBe(0);
        expect(stdin.isRaw).toBe(false);
        expect(stderr.frames.join('')).toBe('');
      } finally {
        client.sqlite.close();
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
