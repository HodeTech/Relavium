import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CliError } from '../process/cli-error.js';
import { OwnedTtyInput, OwnedTtyOutput, captureIo } from '../test-support.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import * as mention from '../render/tui/mention.js';
import { driveHome } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({
    get: () => null,
    set: () => undefined,
    delete: () => false,
  }),
}));

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('installed Home asynchronous publication during native suspension', () => {
  it.each([
    { kind: 'mention', stopped: false },
    { kind: 'mention', stopped: true },
    { kind: 'shell', stopped: false },
    { kind: 'shell', stopped: true },
    { kind: 'picker', stopped: false },
    { kind: 'picker', stopped: true },
  ])('$kind preserves live reporting and respects stop=$stopped', async ({ kind, stopped }) => {
    const f = invocationFixture();
    const client = createClient(':memory:');
    runMigrations(client.db);
    const sessions = createSessionStore(client.db);
    const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-publication-'));
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const captured = captureIo();
    let props: RootAppProps | undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finishList: (value: readonly mention.MentionCandidate[]) => void = () => undefined;
    const listing = new Promise<readonly mention.MentionCandidate[]>((resolve) => {
      finishList = resolve;
    });
    let rejectShell: (cause: unknown) => void = () => undefined;
    const shell = new Promise<never>((_resolve, reject) => {
      rejectShell = reject;
    });
    void shell.catch(() => undefined); // Cleanup may refuse a fixture before its shell entry is reached.
    let rejectModels: (cause: unknown) => void = () => undefined;
    const modelListing = new Promise<never>((_resolve, reject) => {
      rejectModels = reject;
    });
    void modelListing.catch(() => undefined);
    const listModels = vi.fn(() => modelListing);
    const resolver = scriptedResolver([textTurn('ready')]);
    const providers = {
      ...resolver,
      resolveProvider: (id: Parameters<typeof resolver.resolveProvider>[0]) => {
        const provider = resolver.resolveProvider(id);
        return provider === undefined ? undefined : { ...provider, listModels };
      },
    };
    const list = vi.fn(() => listing);
    const read = vi.fn(() => Promise.resolve({ content: 'Unused fixture', sizeBytes: 14 }));
    vi.spyOn(mention, 'createMentionReader').mockReturnValue({ list, read });
    const shellRunner = vi.fn(() => shell);
    const marker =
      kind === 'mention'
        ? 'arriving-home-candidate.ts'
        : kind === 'picker'
          ? "couldn't refresh anthropic"
          : '! shell command failed unexpectedly';
    const refusal = new CliError('invalid_invocation', 'PRIVATE_CLASSIFIED_HOME_REFUSAL');
    const running = driveHome({
      invocation: f.invocation,
      io: {
        ...captured.io,
        stdoutIsTty: true,
        stdinIsTty: true,
        stdin: input,
        nativeStdin: input,
        nativeStdout: output,
        nativeStderr: stderr,
        writeOutAcknowledged: (text) =>
          new Promise<void>((resolve, reject) => {
            output.write(text, (cause) =>
              cause === null || cause === undefined ? resolve() : reject(cause),
            );
          }),
        writeErrAcknowledged: (text) =>
          new Promise<void>((resolve, reject) => {
            stderr.write(text, (cause) =>
              cause === null || cause === undefined ? resolve() : reject(cause),
            );
          }),
      },
      global: {
        cwd,
        configPath: join(cwd, 'absent.toml'),
        json: false,
        color: false,
        verbosity: 'normal',
        noAltScreen: true,
      },
      providers,
      buildSession: async (options) => {
        const built = await buildChatSession(options);
        vi.spyOn(built.session, 'runUserCommand').mockImplementation(shellRunner);
        return built;
      },
      openSessionStore: () => ({
        db: client.db,
        store: sessions,
        close: () => client.sqlite.close(),
      }),
      doctorProbes: { keychain: () => undefined, config: () => undefined, toolHost: {} },
      render: (value) => {
        props = value;
        return render(createElement(RootApp, value), {
          stdin: input,
          stdout: output,
          stderr,
          interactive: true,
          alternateScreen: false,
          exitOnCtrlC: false,
          patchConsole: false,
        });
      },
      getSize: () => ({ cols: 120, rows: 40 }),
      subscribeResize: () => () => undefined,
      subscribeSignals: () => () => undefined,
      subscribeProcessExit: () => () => undefined,
      jobControlLifecycle: {
        supported: false,
        onSuspend: () => () => undefined,
        onContinue: () => () => undefined,
        suspendSelf: () => undefined,
      },
    });
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    let suspended: Promise<void> | undefined;
    try {
      if (props === undefined) throw new Error('Installed Home mount absent.');
      const controller = props.controller;
      controller.handlePaste('hello');
      controller.handleKey('', { return: true });
      await vi.waitFor(() => {
        expect(controller.getSnapshot().session).toBeDefined();
        expect(controller.getSnapshot().submitBusy).toBe(false);
      });
      if (kind === 'mention') {
        controller.handleKey('@', {});
        await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
        expect(shellRunner).not.toHaveBeenCalled();
      } else if (kind === 'picker') {
        controller.handlePaste('/models');
        controller.handleKey('', { return: true });
        await vi.waitFor(() => {
          expect(listModels).toHaveBeenCalledOnce();
          expect(controller.getSnapshot().modelPicker?.loading).toBe(true);
        });
        expect(controller.getSnapshot().modelPicker?.banner).toBeUndefined();
        expect(shellRunner).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      } else {
        controller.handlePaste('!synthetic');
        controller.handleKey('', { return: true });
        await vi.waitFor(() => expect(shellRunner).toHaveBeenCalledOnce());
        expect(list).not.toHaveBeenCalled();
      }
      const port = props.suspendPort;
      await vi.waitFor(() => expect(port?.current()).toBeDefined());
      const suspend = port?.current();
      if (suspend === undefined) throw new Error('Installed Home suspension absent.');
      suspended = suspend(() => held);
      await vi.waitFor(() => expect(input.isRaw).toBe(false));
      if (stopped) {
        f.invocation.finiteExit.fail('cli_internal');
        expect(props.inputEnabled?.()).toBe(false);
        expect(port?.current()).toBeUndefined();
      } else expect(props.inputEnabled?.()).toBe(true);
      const from = output.frames.length;
      if (kind === 'mention') finishList([{ name: marker, path: marker, type: 'file' }]);
      else if (kind === 'picker') rejectModels(refusal);
      else rejectShell(refusal);
      await tick();
      await tick();
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      expect(output.frames.slice(from).join('')).not.toContain(marker);
      release();
      await suspended; // Actual installed endSuspend redraws before final native unmount.
      if (stopped) {
        expect(await running).toBe(9);
        expect(output.frames.slice(from).join(''), 'HOME_STOPPED_COMPLETION_RENDER').not.toContain(
          marker,
        );
      } else {
        await vi.waitFor(() => expect(output.frames.slice(from).join('')).toContain(marker));
        f.invocation.finiteExit.cooperativeCancel(4);
        expect(await running).toBe(0); // Healthy Home consumes the session-end outcome.
      }
      expect(f.registry.activeOwners).toBe(0);
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('readable')).toBe(0);
      expect(port?.current()).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
      expect(f.exit).not.toHaveBeenCalled();
      expect(output.frames.join('') + stderr.frames.join('')).not.toContain('PRIVATE_');
    } finally {
      finishList([]);
      rejectShell(refusal);
      rejectModels(refusal);
      release();
      await suspended;
      f.invocation.finiteExit.cooperativeCancel(4);
      await settled;
      vi.restoreAllMocks();
      if (client.sqlite.open) client.sqlite.close();
      input.destroy();
      output.destroy();
      stderr.destroy();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
