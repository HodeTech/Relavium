import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ToolApprovalLiveContext, ToolApprovalRequest } from '@relavium/core';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { createElement } from 'react';
import { expect, it, vi, type MockInstance } from 'vitest';

import { buildChatSession, type BuiltChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import { mountInk, type InkMount } from '../render/tui/surface-matrix/mount.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

/**
 * What the real `driveHome` hands the Home it mounts names a directory as the rest of the CLI does ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8: project-relative or from `~`, never absolute unless it is outside both): a session's directory on the strip, and the directory a command
 * runs in on the card of the chat the Home hosts. The wires are the host's (`paths` of `RootApp`, `commandPaths` of the chat handler) and a
 * controller test that is handed fake props proves neither, so this drives the real host, mounts the props it built, and reads the screen.
 */
const REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const LIVE: ToolApprovalLiveContext = {
  callId: 'call',
  preview: {
    kind: 'operation',
    target: 'npm test',
    fields: [
      { name: '', value: 'npm' },
      { name: '', value: 'test' },
    ],
  },
};

interface Host {
  readonly props: RootAppProps;
  /** The roots the test's directories are named against. */
  readonly cwd: string;
  readonly homeDir: string;
  /** The turn policy the real chat handler pushed to the session the Home built. */
  readonly policy: () => Parameters<BuiltChatSession['session']['setTurnPolicy']>[0] | undefined;
  readonly sessions: ReturnType<typeof createSessionStore>;
  /** Mount the props the host built, as the terminal would show them. */
  readonly mount: () => InkMount;
}

async function withHome(use: (host: Host) => Promise<void>): Promise<void> {
  const f = invocationFixture();
  const client = createClient(':memory:');
  runMigrations(client.db);
  const sessions = createSessionStore(client.db);
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-paths-')));
  const homeDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-paths-operator-')));
  let props: RootAppProps | undefined;
  let built: BuiltChatSession | undefined;
  let policyPushes: MockInstance<BuiltChatSession['session']['setTurnPolicy']> | undefined;
  let id = 0;
  let finishRender = () => {};
  const exited = new Promise<void>((resolve) => {
    finishRender = resolve;
  });
  const running = driveHome({
    homeDir,
    invocation: f.invocation,
    io: { ...captureIo().io, stdoutIsTty: true, stdinIsTty: true },
    global: {
      cwd,
      json: false,
      color: false,
      configPath: join(cwd, 'absent-global.toml'),
      verbosity: 'normal',
    },
    providers: scriptedResolver([textTurn('first')]),
    now: () => Date.parse('2026-11-25T00:00:00.000Z'),
    uuid: () => `home-paths-${++id}`,
    buildSession: async (options) => {
      built = await buildChatSession(options);
      policyPushes = vi.spyOn(built.session, 'setTurnPolicy');
      return built;
    },
    openSessionStore: () => ({
      store: sessions,
      db: client.db,
      close: () => client.sqlite.close(),
    }),
    // the test's mount draws the frames, its keys are the controller's: the Home's pages swap instead of sliding (MVP-11 unit 7)
    pageSlide: false,
    // The real controller, session and store; the mount below is the test's, over the props the host built.
    render: (value) => {
      props = value;
      value.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return {
        unmount: finishRender,
        waitUntilExit: () => exited,
        waitUntilRenderFlush: () => Promise.resolve(),
      };
    },
    getSize: () => ({ cols: 120, rows: 40 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
  });
  try {
    if (props === undefined) throw new Error('Expected the Home to be mounted.');
    const hostProps = props;
    await use({
      props: hostProps,
      cwd,
      homeDir,
      policy: () => policyPushes?.mock.calls.at(-1)?.[0],
      sessions,
      mount: () =>
        mountInk(createElement(RootApp, hostProps), {
          renderer: hostProps.alternateScreen === true ? 'alt' : 'inline',
          color: false,
          size: { cols: 120, rows: 40 },
        }),
    });
  } finally {
    finishRender();
    await running;
    vi.restoreAllMocks();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

/** Type a first message and wait for the chat the Home builds for it to be idle. */
async function startChat(host: Host): Promise<void> {
  const { controller } = host.props;
  for (const char of 'hello') controller.handleKey(char, {});
  controller.handleKey('', { return: true });
  await vi.waitFor(() => {
    expect(controller.getSnapshot().session).toBeDefined();
    expect(controller.getSnapshot().submitBusy).toBe(false);
  });
}

const rowsOf = (mount: InkMount): string[] => mount.frame().map((line) => line.trim());

it('the card of the command a Home-hosted chat asks about names the directory from the project, as the real handler passes the roots', async () => {
  await withHome(async (host) => {
    await startChat(host);
    const session = host.props.controller.getSnapshot().session;
    if (session === undefined) throw new Error('Expected the chat the Home hosts.');
    void host
      .policy()
      ?.confirm?.(REQUEST, undefined, LIVE)
      ?.catch(() => undefined);
    const approval = session.store.getSnapshot().approval;
    // The facts keep the absolute directory (the protected-path check reads it) and carry the roots the card shortens it against.
    expect(approval?.facts?.cwd).toBe(host.cwd);
    expect(approval?.facts?.paths).toEqual({
      cwd: host.cwd,
      home: host.homeDir,
      win32: process.platform === 'win32',
    });
    const mount = host.mount();
    try {
      await mount.until(() => mount.frame().some((line) => line.includes('Runs in:')));
      await mount.settle();
      const row = mount.frame().find((line) => line.includes('Runs in:')) ?? '';
      expect(row, mount.frame().join('\n')).toContain(
        `Runs in: . (project root: ${basename(host.cwd)})`,
      );
      expect(row).not.toContain(host.cwd);
    } finally {
      mount.unmount();
      session.store.sealToolPreviews(); // a card still open is cancelled, not answered
    }
    host.props.controller.handleKey('c', { ctrl: true });
    host.props.controller.handleKey('c', { ctrl: true });
    await vi.waitFor(() => expect(host.props.controller.getSnapshot().mode).toBe('home'));
    host.props.controller.handleKey('c', { ctrl: true });
    host.props.controller.handleKey('c', { ctrl: true });
  });
});

it('the strip of the Home the host mounts lists this directory’s sessions only, naming the directory from the project; the others are `/resume`’s', async () => {
  await withHome(async (host) => {
    expect(host.props.paths, 'the host hands RootApp the roots').toEqual({
      cwd: host.cwd,
      home: host.homeDir,
      win32: process.platform === 'win32',
    });
    await startChat(host);
    const session = host.props.controller.getSnapshot().session;
    if (session === undefined) throw new Error('Expected the chat the Home hosts.');
    const record = host.sessions.loadFull(session.sessionId)?.session;
    if (record === undefined) throw new Error('Expected the durable session record.');
    const inProject = join(host.cwd, 'packages', 'app');
    mkdirSync(inProject, { recursive: true });
    const places = [
      ['in-project', inProject],
      ['in-home', join(host.homeDir, 'other')],
      ['elsewhere', '/opt/shared/tools'],
    ] as const;
    places.forEach(([name, workingDir], index) => {
      host.sessions.createSession({
        ...record,
        id: `strip-${name}`,
        title: `Strip ${name}`,
        context: { ...record.context, workingDir },
        updatedAt: `2026-11-25T00:00:0${String(index + 1)}.000Z`,
      });
    });
    // Back to the Home, which reads the strip again.
    const { controller } = host.props;
    for (const char of '/cancel') controller.handleKey(char, {});
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('home'));
    const mount = host.mount();
    try {
      // the sessions are the work page's rows (MVP-11 unit 7): down to them
      controller.handleKey('', { downArrow: true });
      await mount.until(() => rowsOf(mount).includes('. (project root)'));
      await mount.settle();
      const rows = rowsOf(mount);
      // The Home lists this directory's work only (MVP-11 unit 7): the chat it hosted is here, named from the project; the sessions of a
      // directory below it, of the home and of elsewhere are other directories', reachable in `/resume` (the next test), not on the strip.
      expect(rows, mount.frame().join('\n')).toContain('. (project root)');
      for (const away of ['packages/app', '~/other', '/opt/shared/tools'])
        expect(rows, away).not.toContain(away);
      expect(rows.join('\n')).not.toContain('Strip ');
      expect(rows.join('\n')).not.toContain(host.cwd);
      expect(controller.getSnapshot().snapshot.totals.sessions).toBe(1);
    } finally {
      mount.unmount();
    }
    controller.handleKey('c', { ctrl: true });
    controller.handleKey('c', { ctrl: true });
  });
});

it('the resume picker of the Home, in All directories, names each session’s directory from the project or the home, as the real handler passes the roots', async () => {
  await withHome(async (host) => {
    await startChat(host);
    const session = host.props.controller.getSnapshot().session;
    if (session === undefined) throw new Error('Expected the chat the Home hosts.');
    const record = host.sessions.loadFull(session.sessionId)?.session;
    if (record === undefined) throw new Error('Expected the durable session record.');
    const places = [
      ['in-project', join(host.cwd, 'packages', 'app')],
      ['in-home', join(host.homeDir, 'other')],
      ['elsewhere', '/opt/shared/tools'],
    ] as const;
    places.forEach(([name, workingDir], index) => {
      host.sessions.createSession({
        ...record,
        id: `pick-${name}`,
        title: `Pick ${name}`,
        context: { ...record.context, workingDir },
        updatedAt: `2026-11-25T00:00:0${String(index + 1)}.000Z`,
      });
    });
    const { controller } = host.props;
    for (const char of '/cancel') controller.handleKey(char, {});
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('home'));
    const mount = host.mount();
    try {
      controller.handleKey('/resume', {}); // a paste: a command line, not the palette
      controller.handleKey('', { return: true });
      // The picker takes keys once its first page is in (a key sent while it loads is not one).
      await vi.waitFor(
        async () => {
          await mount.settle();
          expect(rowsOf(mount).some((row) => row.includes('hello'))).toBe(true);
        },
        { timeout: 3000, interval: 20 },
      );
      mount.key('\t'); // This directory -> All directories
      await vi.waitFor(
        async () => {
          await mount.settle();
          expect(rowsOf(mount), mount.frame().join('\n')).toContain('~/other');
        },
        { timeout: 3000, interval: 20 },
      );
      // A row of the picker is read at its end: the popup lies over the landing (MVP-11 unit 7), whose dimmed rows stand to its left in the
      // terminal's row (the landing's hint beside the third directory at 120×40).
      const rows = rowsOf(mount);
      const listed = (dir: string): boolean =>
        rows.some((row) => row === dir || row.endsWith(`  ${dir}`));
      expect(listed('packages/app'), mount.frame().join('\n')).toBe(true);
      expect(listed('~/other')).toBe(true);
      expect(listed('/opt/shared/tools')).toBe(true);
      expect(rows.join('\n')).not.toContain(host.cwd);
      expect(rows.join('\n')).not.toContain(host.homeDir);
    } finally {
      mount.unmount();
    }
    controller.handleKey('c', { ctrl: true });
    controller.handleKey('c', { ctrl: true });
  });
});
