import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { chatCommand, chatResumeCommand, drivePlain } from './chat.js';

/**
 * The stand-alone resume picker's "All directories" scope names each session's directory as the rest of the CLI does ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8): the project in words, one inside it from the project, one outside both whole. The picker's own tests hand it roots; this drives the real
 * `chatResumeCommand` and reads the screen, because the wire from the handler to the picker (`paths`) is the part a unit test of the picker cannot prove.
 */
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

it('the picker `chat resume` opens names each directory from the project, and whole where it is outside it, as the real handler passes the roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-picker-paths-'));
  const client = createClient(':memory:');
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const captured = captureIo();
  const cwd = realpathSync.native(root);
  const global = {
    cwd,
    configPath: join(root, 'absent.toml'),
    json: false,
    color: false,
    noAltScreen: true,
    verbosity: 'normal' as const,
  };
  const stdin = new OwnedTtyInput();
  const stdout = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  stdout.columns = 80;
  stdout.rows = 24;
  const f = invocationFixture();
  try {
    await chatCommand(
      { agent: undefined },
      {
        global,
        io: { ...captured.io, stdin: Readable.from(['seed\n/exit\n']) },
        providers: scriptedResolver([textTurn('saved answer')]),
        drive: drivePlain,
        openSessionStore: () => ({ store, db: client.db, close: () => {} }),
        uuid: (() => {
          let n = 0;
          return () => `saved-${String(++n)}`;
        })(),
      },
    );
    const seeded = store.loadFull('saved-1')?.session;
    if (seeded === undefined) throw new Error('Expected the seeded session.');
    // Two more of the same conversation's record, started elsewhere: inside the project and outside it.
    const places = [
      ['inside', join(cwd, 'packages', 'app')],
      ['outside', '/opt/shared/elsewhere-directory'],
    ] as const;
    places.forEach(([name, workingDir], index) => {
      store.createSession({
        ...seeded,
        id: `other-${name}`,
        title: `Elsewhere ${name}`,
        context: { ...seeded.context, workingDir },
        updatedAt: new Date(Date.parse(seeded.updatedAt) + (index + 1) * 1000).toISOString(),
      });
    });
    const running = chatResumeCommand(
      { sessionId: undefined },
      {
        global,
        io: {
          ...captured.io,
          stdin,
          nativeStdin: stdin,
          nativeStdout: stdout,
          nativeStderr: stderr,
          stdinIsTty: true,
          stdoutIsTty: true,
          writeOutAcknowledged: (text: string) => acknowledgeWrite(stdout, text),
        },
        invocation: f.invocation,
        lifecycle,
        jobControlLifecycle,
        resolveKeys: () => ({ providers: scriptedResolver([]) }),
        openSessionStore: () => ({ store, db: client.db, close: () => {} }),
        drive: () => Promise.resolve({ kind: 'exit' }),
      },
    );
    await vi.waitFor(() => expect(stdout.frames.join('')).toContain('Resume a session'));
    stdin.push('\t'); // This directory -> All directories
    await vi.waitFor(() => expect(stdout.frames.join('')).toContain('elsewhere-directory'), {
      timeout: 3000,
      interval: 20,
    });
    const screen = stdout.frames.join('');
    expect(screen).toContain('All directories');
    expect(screen, 'the project itself, in words').toContain('. (project root)');
    expect(screen, 'inside the project, from the project').toContain('packages/app');
    expect(screen, 'outside both, whole').toContain('/opt/shared/elsewhere-directory');
    // The absolute path of the project is never what a row says (it is what the picker drew before it was given the roots).
    expect(screen).not.toContain(join(cwd, 'packages'));
    stdin.push('\x1b');
    await running;
  } finally {
    client.sqlite.close();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
