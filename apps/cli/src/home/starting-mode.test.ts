import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDefinition, SessionTurnPolicy } from '@relavium/core';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema, type ChatMode } from '@relavium/shared';
import { render, type Instance } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  buildChatSession,
  buildResumedChatSession,
  type BuiltChatSession,
} from '../chat/session-host.js';
import { assertStartingModeDispatch } from '../chat/starting-mode.js';
import * as osKeychain from '../secrets/os-keychain.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { CliError } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import { stripTerminalControls } from '../render/sanitize.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import type { HomeChatSession } from '../render/tui/home-controller.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

const ENTER = { return: true } as const;
const plain = (frame: string) => stripTerminalControls(frame).replace(/\s+/g, ' ');
const fullHint = (frame: string) =>
  /You started in ask mode\..*Shift\+Tab.*\/mode.*configure the startup default\./.test(
    plain(frame),
  );
function deferred() {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

interface BuildRecord {
  readonly built: BuiltChatSession;
  readonly policy: () => SessionTurnPolicy | undefined;
}

/** Real Home, controller, builders, SQLite, notice store and Ink on owned handle-free streams. */
async function fixture(
  options: {
    readonly mode?: ChatMode;
    readonly hintShown?: boolean;
    readonly inline?: boolean;
    readonly owned?: boolean;
    readonly seedAgent?: AgentDefinition;
    readonly refuseFreshAttempt?: number;
    readonly beforeFreshReturn?: (
      built: BuiltChatSession,
      attempt: number,
      resize: (rows: number) => void,
    ) => void | Promise<void>;
  } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-starting-mode-')));
  const home = join(root, 'operator');
  const cwd = join(root, 'workspace');
  const configPath = join(home, '.relavium', 'config.toml');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const writeMode = (mode: ChatMode, hintShown = true) =>
    writeFileSync(
      configPath,
      `[preferences]\ndefault_mode="${mode}"\n${hintShown ? 'default_mode_hint_shown=true\n' : ''}`,
    );
  writeMode(options.mode ?? 'ask', options.hintShown ?? true);
  const hintRecorded = () =>
    /default_mode_hint_shown\s*=\s*true/.test(readFileSync(configPath, 'utf8'));
  const client = createClient(':memory:');
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  if (options.seedAgent !== undefined) {
    const iso = '2026-11-11T00:00:00.000Z';
    const record = {
      id: 'saved-frozen',
      title: 'Frozen saved agent',
      agentSlug: options.seedAgent.id,
      agentSnapshot: options.seedAgent,
      context: { workingDir: cwd, fsScopeTier: 'project' },
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: iso,
      updatedAt: iso,
    } as const;
    store.createSession(record);
    store.writeTurn({
      session: record,
      messages: [
        {
          message: {
            id: 'saved-user',
            sessionId: record.id,
            sequenceNumber: 0,
            role: 'user',
            content: [{ type: 'text', text: 'saved prompt' }],
            timestamp: iso,
          },
          meta: { userDisplayText: 'saved prompt' },
        },
        {
          message: {
            id: 'saved-assistant',
            sessionId: record.id,
            sequenceNumber: 1,
            role: 'assistant',
            content: [{ type: 'text', text: 'saved answer' }],
            timestamp: iso,
          },
        },
      ],
    });
  }
  const input = new OwnedTtyInput();
  const stdout = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  const ownership = options.owned === true ? invocationFixture() : undefined;
  stdout.columns = 110;
  stdout.rows = 30;
  let resizeListener: (() => void) | undefined;
  const resize = (rows: number) => {
    stdout.rows = rows;
    resizeListener?.();
  };
  let props: RootAppProps | undefined;
  let instance: Instance | undefined;
  let id = 0;
  let tick = 0;
  const fresh: BuildRecord[] = [];
  const restored: BuildRecord[] = [];
  const freshOptions: Parameters<typeof buildChatSession>[0][] = [];
  const publications: {
    session: HomeChatSession;
    mode: ChatMode;
    policy: SessionTurnPolicy | undefined;
  }[] = [];
  const seen = new WeakSet<HomeChatSession>();
  const firstFrames = new WeakMap<HomeChatSession, string>();
  const hintFrames: boolean[] = [];
  const rewriteFrames: boolean[] = [];
  let closeDuringHint = false;
  stdout.onFrame = (frame) => {
    const session = props?.controller.getSnapshot().session;
    if (
      session !== undefined &&
      !firstFrames.has(session) &&
      /(?:ask|plan|accept-edits|auto) mode/.test(frame)
    )
      firstFrames.set(session, plain(frame));
    if (fullHint(frame)) {
      hintFrames.push(hintRecorded());
      if (closeDuringHint) stdout.destroy();
    }
    if (plain(frame).includes('removes its comments and ordering.'))
      rewriteFrames.push(hintRecorded());
  };
  const observe = (built: BuiltChatSession): BuildRecord => {
    const spy = vi.spyOn(built.session, 'setTurnPolicy');
    return { built, policy: () => spy.mock.calls.at(-1)?.[0] };
  };
  const deps: HomeDeps = {
    ...(ownership === undefined ? {} : { invocation: ownership.invocation }),
    homeDir: home,
    outputStoreFactory: () => Promise.resolve(undefined),
    io: {
      nativeStdin: input,
      nativeStdout: stdout,
      nativeStderr: stderr,
      stdin: input,
      env: {},
      stdoutIsTty: true,
      stdinIsTty: true,
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
      writeOutAcknowledged: (text) => acknowledgeWrite(stdout, text),
      writeErrAcknowledged: (text) => acknowledgeWrite(stderr, text),
    },
    global: {
      cwd,
      configPath,
      json: false,
      color: false,
      verbosity: 'normal',
      noAltScreen: options.inline ?? false,
    },
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    providers: scriptedResolver(
      Array.from({ length: 4 }, (_, n) => textTurn(`offline reply ${n}`)),
    ),
    openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
    now: () => 1_750_000_000_000 + tick++,
    uuid: () => `home-starting-${id++}`,
    buildSession: async (buildOptions) => {
      freshOptions.push(buildOptions);
      if (options.refuseFreshAttempt === freshOptions.length)
        throw new CliError('invalid_invocation', 'The replacement could not be constructed.');
      const built = await buildChatSession(buildOptions);
      fresh.push(observe(built));
      await options.beforeFreshReturn?.(built, fresh.length, resize);
      return built;
    },
    buildResumedSession: async (buildOptions) => {
      const built = await buildResumedChatSession(buildOptions);
      restored.push(observe(built));
      return built;
    },
    render: (value, renderOptions) => {
      props = value;
      value.controller.subscribe(() => {
        const session = value.controller.getSnapshot().session;
        if (session !== undefined && !seen.has(session)) {
          seen.add(session);
          const all = [...fresh, ...restored];
          const record = all.findLast(
            (candidate) => candidate.built.sessionId === session.sessionId,
          );
          publications.push({
            session,
            mode: session.store.getSnapshot().mode,
            policy: record?.policy(),
          });
        }
      });
      instance = render(createElement(RootApp, value), {
        ...renderOptions,
        stdin: input,
        stdout,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: false,
      });
      return instance;
    },
    getSize: () => ({ cols: stdout.columns, rows: stdout.rows }),
    subscribeResize: (listener) => {
      resizeListener = listener;
      return () => {
        resizeListener = undefined;
      };
    },
    subscribeSignals: () => () => undefined,
    subscribeProcessExit: () => () => undefined,
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => undefined,
      onContinue: () => () => undefined,
      suspendSelf: () => undefined,
    },
    onboardingTerminalLifecycle: {
      onInput: () => () => undefined,
      isRawMode: () => false,
      setRawMode: () => undefined,
    },
    onboardingPrompter: {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      select: () => Promise.resolve(Symbol('cancel')),
      password: () => Promise.resolve(Symbol('cancel')),
      isCancel: (value): value is symbol => typeof value === 'symbol',
    },
    writeControl: () => undefined,
    exit: () => undefined,
  };
  let error: unknown;
  const outcome = driveHome(deps).catch((cause: unknown) => {
    error = cause;
  });
  await vi.waitFor(() => expect(props).toBeDefined());
  if (props === undefined) throw new Error('Home did not mount');
  const mounted = props;
  await instance?.waitUntilRenderFlush();
  const command = (text: string) => {
    mounted.controller.handlePaste(text);
    mounted.controller.handleKey('', ENTER);
  };
  const ready = async (prior?: HomeChatSession) => {
    await vi.waitFor(() => {
      const current = mounted.controller.getSnapshot();
      expect(current.mode).toBe('chat');
      expect(current.session).toBeDefined();
      if (prior !== undefined) expect(current.session).not.toBe(prior);
      expect(current.submitBusy).toBe(false);
      expect(current.nativeActionBusy).toBe(false);
      expect(current.session?.store.getSnapshot().state.status).toBe('idle');
    });
    await instance?.waitUntilRenderFlush();
    const current = mounted.controller.getSnapshot().session;
    if (current === undefined) throw new Error('No current chat');
    return current;
  };
  const resume = async () => {
    mounted.controller.handleKey('', { downArrow: true });
    expect(mounted.controller.getSnapshot().continueSessionId).toBeDefined();
    mounted.controller.handleKey('', ENTER);
    return ready();
  };
  const close = async () => {
    try {
      if (error === undefined) {
        mounted.controller.handleKey('', { escape: true }); // release an open picker before normal exit
        if (mounted.controller.getSnapshot().session !== undefined) {
          command('/exit');
          await vi.waitFor(() => expect(mounted.controller.getSnapshot().mode).toBe('home'));
        }
        if (error === undefined) mounted.controller.handleKey('c', { ctrl: true });
      }
      await outcome;
    } finally {
      instance?.cleanup();
      input.destroy();
      stdout.destroy();
      stderr.destroy();
      if (client.sqlite.open) client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
  return {
    root,
    home,
    cwd,
    configPath,
    client,
    store,
    props: mounted,
    stdout,
    fresh,
    restored,
    freshOptions,
    publications,
    firstFrames,
    hintFrames,
    rewriteFrames,
    writeMode,
    hintRecorded,
    command,
    ready,
    resume,
    resize,
    outcome,
    close,
    error: () => error,
    ownership,
    closeHintOutput: () => {
      closeDuringHint = true;
    },
  };
}

describe('Home configured starting modes and frozen clear binding', () => {
  it.each(['plan', 'invalid'])(
    'live doctor observes %s through the original owned authority',
    async (observed) => {
      const keychain = vi.spyOn(osKeychain, 'createOsKeychainStore').mockReturnValue({
        get: () => null,
        set: () => undefined,
        delete: () => false,
      });
      const f = await fixture({ mode: 'auto', owned: true });
      try {
        f.command('first');
        const prior = await f.ready();
        const selection = f.fresh[0]?.built.startingMode;
        const confirm = f.fresh[0]?.policy()?.confirm;
        if (selection === undefined || confirm === undefined)
          throw new Error('Missing original auto policy');
        const guard = () =>
          assertStartingModeDispatch(
            selection.authority,
            confirm,
            'write_file',
            new Set(['write_file']),
          );
        expect(guard).not.toThrow();
        if (observed === 'plan') f.writeMode('plan');
        else writeFileSync(f.configPath, '[preferences]\ndefault_mode="PRIVATE_INVALID_MODE"\n');
        f.command('/doctor');
        await f.ready();
        expect(guard, 'W2_STARTUP_HOME_DOCTOR_OBSERVATION').toThrow('revoked');
        expect(f.props.controller.getSnapshot().session).toBe(prior);
        expect(f.stdout.frames.join(' ')).not.toContain('PRIVATE_INVALID_MODE');
      } finally {
        await f.close();
        keychain.mockRestore();
      }
    },
  );
  it('binds first publication/frame and policy together for fresh, clear, resume and reseat', async () => {
    const f = await fixture({ mode: 'auto' });
    try {
      f.command('first');
      const first = await f.ready();
      expect(f.publications[0]?.mode).toBe('auto');
      expect(f.firstFrames.get(first)).toContain('auto mode');
      expect(f.publications[0]?.policy?.advertise).toBeUndefined();
      await expect(
        f.publications[0]?.policy?.confirm?.({
          toolId: 'write_file',
          action: 'fs_write',
          preview: { path: 'notes.md' },
        }),
      ).resolves.toMatchObject({ outcome: 'approve' });

      f.writeMode('plan');
      f.command('/clear');
      const cleared = await f.ready(first);
      expect(cleared.sessionId).not.toBe(first.sessionId);
      expect(f.publications[1]?.mode).toBe('plan');
      expect(f.firstFrames.get(cleared)).toContain('plan mode');
      expect(f.publications[1]?.policy?.advertise?.('write_file')).toBe(false);
      expect(f.freshOptions[1]?.agent).toBe(f.fresh[0]?.built.agent);
      f.command('save the fresh conversation');
      await f.ready();
      f.command('/exit');
      await vi.waitFor(() => expect(f.props.controller.getSnapshot().mode).toBe('home'));

      f.writeMode('accept-edits');
      const resumed = await f.resume();
      expect(resumed.sessionId).toBe(cleared.sessionId);
      expect(f.publications[2]?.mode).toBe('accept-edits');
      expect(f.firstFrames.get(resumed)).toContain('accept-edits mode');
      const decision = f.publications[2]?.policy?.confirm?.({
        toolId: 'write_file',
        action: 'fs_write',
        preview: { path: 'notes.md' },
      });
      expect(resumed.store.getSnapshot().approval).toBeDefined();
      resumed.store.answerApproval({ outcome: 'reject' });
      await expect(decision).resolves.toMatchObject({ outcome: 'reject' });

      f.writeMode('ask');
      f.command('/models');
      await vi.waitFor(() => expect(f.props.controller.getSnapshot().modelPicker).toBeDefined());
      f.props.controller.handlePaste('claude-opus-4-8');
      f.props.controller.handleKey('', ENTER);
      if (f.props.controller.getSnapshot().modelPicker?.phase === 'effort')
        f.props.controller.handleKey('', ENTER);
      const reseated = await f.ready(resumed);
      expect(reseated.sessionId).toBe(resumed.sessionId);
      expect(f.publications[3]?.mode).toBe('ask');
      expect(f.firstFrames.get(reseated)).toContain('ask mode');
      expect(f.publications[3]?.policy?.advertise?.('write_file')).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.each(['older-built-in', 'authored-same-id'] as const)(
    'clear preserves a frozen %s snapshot without upgrading its grant',
    async (kind) => {
      const agent: AgentDefinition = AgentSchema.parse({
        id: 'relavium-chat',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt:
          kind === 'older-built-in'
            ? 'Older built-in read-only snapshot.'
            : 'Authored agent with the same id.',
        tools:
          kind === 'older-built-in' ? ['read_file', 'list_directory', 'git_status'] : ['read_file'],
      });
      const f = await fixture({ mode: 'plan', seedAgent: agent });
      try {
        const resumed = await f.resume();
        expect(f.restored[0]?.built.agent).toEqual(agent);
        f.writeMode('accept-edits');
        f.command('/clear');
        const cleared = await f.ready(resumed);
        expect(cleared.sessionId).not.toBe('saved-frozen');
        expect(f.freshOptions[0]?.agent).toBe(f.restored[0]?.built.agent);
        expect(f.fresh[0]?.built.agent).toEqual(agent);
        expect(f.fresh[0]?.built.agent.tools).not.toContain('write_file');
        expect(f.fresh[0]?.built.agent.tools).not.toContain('edit_file');
        expect(f.freshOptions[0]?.cwd).toBe(f.cwd);
        expect(f.restored[0]?.built.fsPolicy).toBeDefined();
        expect(f.freshOptions[0]?.fsPolicy).toBe(f.restored[0]?.built.fsPolicy);
        expect(cleared.store.getSnapshot().mode).toBe('accept-edits');
      } finally {
        await f.close();
      }
    },
  );

  it('a failed narrower clear build revokes the retained auto host before publication', async () => {
    const f = await fixture({
      mode: 'auto',
      refuseFreshAttempt: 2,
    });
    try {
      f.command('first');
      const prior = await f.ready();
      const selection = f.fresh[0]?.built.startingMode;
      const hook = f.fresh[0]?.policy()?.confirm;
      if (selection === undefined || hook === undefined)
        throw new Error('Missing actual auto host policy');
      expect(() =>
        assertStartingModeDispatch(
          selection.authority,
          hook,
          'write_file',
          new Set(['write_file']),
        ),
      ).not.toThrow();
      f.writeMode('plan');
      f.command('/clear');
      await vi.waitFor(() => expect(f.props.controller.getSnapshot().submitBusy).toBe(false));
      expect(f.props.controller.getSnapshot().session).toBe(prior);
      expect(f.freshOptions[1]?.startingMode?.mode).toBe('plan');
      expect(f.publications).toHaveLength(1);
      expect(() =>
        assertStartingModeDispatch(
          selection.authority,
          hook,
          'write_file',
          new Set(['write_file']),
        ),
      ).toThrow('revoked');
      f.command('/mode plan');
      expect(prior.store.getSnapshot().mode).toBe('plan');
      await f.ready();
      expect(f.fresh[0]?.policy()?.advertise?.('write_file')).toBe(false);
      f.command('continue after the refused replacement');
      await vi.waitFor(() => expect(prior.store.getSnapshot().state.turnCount).toBe(2));
      await f.ready();
      expect(f.props.controller.getSnapshot().session).toBe(prior);
      expect(prior.store.getSnapshot().state.turnCount).toBe(2);
      f.command('/exit');
      await vi.waitFor(() => expect(f.props.controller.getSnapshot().mode).toBe('home'));
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'malformed config refuses /models visibly without widening a retained host (chat=%s)',
    async (retained) => {
      const f = await fixture({ mode: 'auto', owned: retained });
      try {
        let prior: HomeChatSession | undefined;
        if (retained) {
          f.command('first');
          prior = await f.ready();
        }
        const selection = f.fresh[0]?.built.startingMode;
        const hook = f.fresh[0]?.policy()?.confirm;
        writeFileSync(f.configPath, '[preferences]\ndefault_mode="PRIVATE_INVALID_MODE"\n');
        f.props.controller.handleKey('/', {});
        for (const character of 'models') f.props.controller.handleKey(character, {});
        f.props.controller.handleKey('', ENTER);
        if (retained) {
          // The live picker can show cached bound model/effort. Selecting a replacement is
          // the strict settings read; a file change alone is not an observed revocation.
          await vi.waitFor(() =>
            expect(f.props.controller.getSnapshot().modelPicker).toBeDefined(),
          );
          f.props.controller.handlePaste('claude-opus-4-8');
          f.props.controller.handleKey('', ENTER);
          if (f.props.controller.getSnapshot().modelPicker?.phase === 'effort')
            f.props.controller.handleKey('', ENTER);
          await vi.waitFor(() => expect(f.props.controller.getSnapshot().submitBusy).toBe(false));
          expect(prior?.store.getSnapshot().state.warnings.join(' ')).toContain('could not switch');
          await vi.waitFor(() =>
            expect(f.stdout.frames.some((frame) => plain(frame).includes('could not switch'))).toBe(
              true,
            ),
          );
        } else {
          await vi.waitFor(() =>
            expect(f.props.controller.getSnapshot().notice).toContain(
              'could not read chat settings',
            ),
          );
          await vi.waitFor(() =>
            expect(
              f.stdout.frames.some((frame) =>
                plain(frame).includes('could not read chat settings'),
              ),
            ).toBe(true),
          );
        }
        expect(f.props.controller.getSnapshot().modelPicker).toBeUndefined();
        expect(f.props.controller.getSnapshot().session).toBe(prior);
        expect(f.error()).toBeUndefined();
        expect(f.ownership?.registry.termination).toBeUndefined();
        expect(f.stdout.frames.map(plain).join(' ')).not.toContain('PRIVATE_INVALID_MODE');
        if (retained) {
          if (selection === undefined || hook === undefined)
            throw new Error('Missing retained auto policy');
          expect(() =>
            assertStartingModeDispatch(
              selection.authority,
              hook,
              'write_file',
              new Set(['write_file']),
            ),
          ).toThrow('revoked');
        }
      } finally {
        await f.close();
        if (f.ownership !== undefined) expect(f.ownership.registry.activeOwners).toBe(0);
      }
    },
  );
});

describe('Home hint acknowledgement through actual measured Ink output', () => {
  it.each([false, true])(
    'records only after complete displayed hint and rewrite disclosure (inline=%s)',
    async (inline) => {
      const f = await fixture({ hintShown: false, inline });
      try {
        f.command('first');
        const first = await f.ready();
        expect(f.hintFrames[0]).toBe(false);
        expect(f.rewriteFrames[0]).toBe(false);
        expect(f.hintRecorded()).toBe(true);
        expect(f.firstFrames.get(first)).toContain('ask mode');
        f.command('/clear');
        const fresh = await f.ready(first);
        expect(
          fresh.store
            .getSnapshot()
            .state.transcript.some((entry) => entry.text.startsWith('You started in ask mode.')),
        ).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it('does not record a clipped one-row hint and retries only on a new visible activation', async () => {
    const f = await fixture({
      hintShown: false,
      beforeFreshReturn: (_built, attempt, resize) => {
        if (attempt === 1) resize(1);
      },
    });
    try {
      f.command('first');
      const first = await f.ready();
      expect(f.hintFrames).toEqual([]);
      expect(f.hintRecorded()).toBe(false);
      f.resize(30);
      await vi.waitFor(() => expect(f.stdout.frames.some(fullHint)).toBe(true));
      expect(f.hintRecorded()).toBe(false);
      f.command('/clear');
      await f.ready(first);
      expect(f.hintRecorded()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('does not record when the output closes during the actual hint paint', async () => {
    const f = await fixture({ hintShown: false });
    try {
      f.closeHintOutput();
      f.command('first');
      await f.outcome;
      expect(f.hintFrames[0]).toBe(false);
      expect(f.hintRecorded()).toBe(false);
      expect(String(f.error())).toContain('terminal output closed');
    } finally {
      await f.close();
    }
  });

  it('does not consume the hint in a background build discarded before active publication', async () => {
    const gate = deferred();
    const building = deferred();
    const f = await fixture({
      hintShown: false,
      beforeFreshReturn: async () => {
        building.release();
        await gate.promise;
      },
    });
    try {
      f.command('discard this build');
      await building.promise;
      expect(f.hintRecorded()).toBe(false);
      f.props.controller.handleKey('c', { ctrl: true });
      gate.release();
      await f.outcome;
      expect(f.publications).toEqual([]);
      expect(f.hintFrames).toEqual([]);
      expect(f.hintRecorded()).toBe(false);
    } finally {
      gate.release();
      await f.close();
    }
  });
});
