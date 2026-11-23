import { createCliInvocation } from '../process/invocation.js';
import { randomUUID } from 'node:crypto';
import { invocationFixture } from '../process/invocation.test-support.js';
import {
  holdNativeToolProcess,
  witnessNativeToolProcess,
} from '../commands/native-forwarding.test-support.js';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  createClient,
  createEffectJournalStore,
  createRunHistoryStore,
  createProviderStore,
  createRunPinStore,
  createSessionStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import {
  REASONING_EFFORTS,
  RunEventSchema,
  type ReasoningEffort,
  type RunEvent,
} from '@relavium/shared';
import type { AskUserDelegate, AskUserRequest, ToolRoundLimitHook } from '@relavium/core';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render as renderInk, type Instance, type Key } from 'ink';
import { createElement, isValidElement } from 'react';

import {
  ABORTED_EFFECT_ATTENTION_NOTICE,
  buildChatSession,
  buildResumedChatSession,
  type BuildChatSessionOptions,
} from '../chat/session-host.js';
import { applyChatMode, makeChatModeEnv } from '../chat/chat-mode-host.js';
import { scriptedProvider, scriptedResolver, stop, textTurn } from '../chat/test-support.js';
import { createConsentGate, type ConsentSubject } from '../engine/mcp-consent-gate.js';
import type { ProviderResolver } from '../engine/providers.js';
import { findProjectConfigDir } from '../config/paths.js';
import type { KeychainStore } from '../secrets/keychain.js';
import {
  commandGrantRoot,
  createCommandGrantStore,
  type CommandGrantStore,
} from '../permissions/command-grants.js';
import type { ChatStoreController } from '../render/tui/chat-store.js';
import { reconcileInterruptedRuns } from '../history/reconcile.js';
import { terminalOutboxPath } from '../history/open.js';
import { createFileTerminalOutbox } from '../engine/terminal-outbox.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { ClackOnboardingDeps } from '../onboarding/wizard.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import { SHEET_CONFIRM_DWELL_MS } from '../render/tui/permissions-sheet.js';
import { OwnedTtyInput, OwnedTtyOutput, seedRun } from '../test-support.js';
import { DISABLE_MOUSE, ENABLE_MOUSE, HIDE_CURSOR, SHOW_CURSOR } from '../render/alt-screen.js';
import type { JobControlLifecycle, SuspendPort } from '../render/suspend.js';
import { agentSheetLines } from '../render/tui/agent-sheet.js';
import { permissionsSheetOf } from '../render/tui/chat-sheet.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import { IMPORT_PATH_MESSAGE } from '../render/tui/import-card.js';
import { PRICING_ACTION_SET, PRICING_NOT_RECORDED } from '../render/tui/pricing-card.js';
import {
  defaultSubscribeProcessExit,
  defaultSubscribeSignals,
  driveHome,
  type HomeDeps,
  type OnboardingTerminalLifecycle,
} from './drive-home.js';
import { shouldOpenHome } from './should-open-home.js';
import { RunHost, type RunHostSnapshot } from './run-host.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;
/** The slack a real-clock dwell is waited past its constant, so a key pressed at the edge lands inside the window it needs. */
const SETTLE_MARGIN_MS = 200;

// Default production mounts are intercepted only to supply owned, handle-free TTY streams.
// Preserve every production render option and observe real Ink writes before the journal sweep.
const inkRenderer = vi.hoisted(() => ({ render: vi.fn<(typeof import('ink'))['render']>() }));
vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ink')>()),
  render: inkRenderer.render,
}));
vi.mock('node:crypto', { spy: true });

// Regression for the `provider_auth` bug: the Home built an ENV-ONLY key resolver, so a key stored in the OS
// keychain (the normal `relavium provider add` path) was invisible while `relavium chat` (keychain-wired) worked.
// Mock the keychain accessor (the test env never touches the real store) + spy the resolver's keychain arg. Both
// mocks delegate to real behavior, so the other tests (which inject `providers`) are unaffected — the default
// resolver path (and thus these spies) only runs when `providers` is NOT injected.
const { keychainSentinel, resolverKeychainArg } = vi.hoisted(() => {
  const resolverKeychainArg: { value: unknown } = { value: 'unset' };
  return {
    keychainSentinel: { get: () => null, set: () => undefined, delete: () => false },
    resolverKeychainArg,
  };
});
vi.mock('../secrets/os-keychain.js', () => ({ createOsKeychainStore: () => keychainSentinel }));
vi.mock('../engine/providers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/providers.js')>();
  type Params = Parameters<typeof actual.createProviderResolver>;
  return {
    ...actual,
    createProviderResolver: (env: Params[0], keychain?: Params[1]) => {
      resolverKeychainArg.value = keychain;
      return actual.createProviderResolver(env, keychain); // type-safe forward (no cast)
    },
  };
});

/**
 * `driveHome` owns the PROCESS lifetime: it opens the durable db once, wires the controller + the single-ink
 * mount, the SIGINT/SIGTERM lifecycle, and the bracketed-paste DECSET toggles. These drive it through an injected
 * ink mount (no real TTY) and assert the contract directly: a clean Home exit resolves 0 and closes the shared db
 * once with paste-mode restored; an external signal tears the live chat down and exits `128+signo`; `startChat`
 * builds a real default-agent session. The session state machine itself is unit-tested in home-controller.test.ts.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** A resolver whose provider records each request it is sent, so a test sees the tools the model was offered. */
function capturingResolver(scripts: StreamChunk[][]): {
  readonly providers: ProviderResolver;
  readonly requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  const inner = scriptedProvider(scripts);
  const provider: LlmProvider = {
    ...inner,
    stream: (request, key, options) => {
      requests.push(request);
      return inner.stream(request, key, options);
    },
  };
  return {
    providers: {
      resolveProvider: (id) => (id === 'anthropic' ? provider : undefined),
      keyFor: () => 'test-key',
    },
    requests,
  };
}
/** The Permissions tab's sheet, while the Home's tab host is open on it (the bare Home's `/permissions`, ADR-0140 §3); `undefined` otherwise. */
const tabSheetOf = (props: RootAppProps) => {
  const screen = props.controller.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host.sheet : undefined;
};
const type = (props: RootAppProps, text: string): void => {
  for (const ch of text) props.controller.handleKey(ch, {});
};

/** A scripted onboarding prompter that CANCELS immediately (its `select` returns the cancel sentinel) — the default
 *  for every drive-home test so a key-less resolver never triggers the REAL clack prompts (which render to stdout). */
const CANCEL_ONBOARDING: ClackOnboardingDeps = {
  intro: () => undefined,
  outro: () => undefined,
  note: () => undefined,
  select: () => Promise.resolve(Symbol('cancel')),
  password: () => Promise.resolve(Symbol('cancel')),
  isCancel: (v): v is symbol => typeof v === 'symbol',
};
const ENTER = { return: true } as const;
const CTRL_C = { ctrl: true } as const;
const INERT_JOB_CONTROL: JobControlLifecycle = {
  supported: false,
  onSuspend: () => () => undefined,
  onContinue: () => () => undefined,
  suspendSelf: () => undefined,
};
const INERT_ONBOARDING_TERMINAL: OnboardingTerminalLifecycle = {
  onInput: () => () => undefined,
  isRawMode: () => false,
  setRawMode: () => undefined,
};

const NATIVE_RETURN = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: true,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
describe('driveHome (2.5.B / ADR-0054)', () => {
  let client: DbClient;
  let closeSpy: ReturnType<typeof vi.fn>;
  let cwd: string;
  let testHomeDir: string;

  const io: CliIo = {
    writeOut: () => undefined,
    writeErr: () => undefined,
    writeOutAcknowledged: () => Promise.resolve(),
    writeErrAcknowledged: () => Promise.resolve(),
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: Readable.from([]), // a real, already-ended stream (driveHome never reads it)
  };

  beforeEach(() => {
    inkRenderer.render.mockReset();
    client = createClient(':memory:');
    runMigrations(client.db);
    closeSpy = vi.fn();
    cwd = mkdtempSync(join(tmpdir(), 'relavium-home-'));
    testHomeDir = mkdtempSync(join(tmpdir(), 'relavium-operator-home-'));
  });
  afterEach(() => {
    if (client.sqlite.open) client.sqlite.close();
    rmSync(testHomeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const global: GlobalOptions = {
    json: false,
    color: false,
    get cwd() {
      return cwd;
    },
    configPath: join(tmpdir(), 'no-such-relavium-config.toml'), // absent ⇒ defaults (loadConfigFile tolerates ENOENT)
    verbosity: 'normal',
  };

  function makeDeps(
    capture: (props: RootAppProps) => void,
    overrides: Partial<HomeDeps> = {},
  ): {
    deps: HomeDeps;
    unmount: ReturnType<typeof vi.fn>;
    writeControl: ReturnType<typeof vi.fn>;
    signalHandlers: ((signo: number) => void)[];
    exitHandlers: (() => void)[];
  } {
    const signalHandlers: ((signo: number) => void)[] = [];
    const exitHandlers: (() => void)[] = [];
    const opened: OpenedSessionStore = {
      store: createSessionStore(client.db),
      db: client.db,
      close: closeSpy,
    };
    let acknowledgeExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      acknowledgeExit = resolve;
    });
    const unmount = vi.fn(() => acknowledgeExit());
    const writeControl = vi.fn();
    let uuidN = 0;
    const deps: HomeDeps = {
      homeDir: testHomeDir,
      outputStoreFactory: () => Promise.resolve(undefined),
      io,
      global,
      providers: scriptedResolver([textTurn('hello from the agent')]),
      openSessionStore: () => opened,
      now: () => 1_750_000_000_000,
      uuid: () => `id-${uuidN++}`, // unique per call (mirrors production randomUUID): the session id + message ids never collide
      render: (props) => {
        capture(props);
        const native = props.nativePrompt;
        native?.bindVisibility((expected) => native.getSnapshot() === expected);
        props.onRendererReady?.(async (publish) => {
          await publish?.();
        });
        return {
          unmount,
          waitUntilRenderFlush: () => Promise.resolve(),
          waitUntilExit: () => exited,
        };
      },
      getSize: () => ({ cols: 120, rows: 40 }),
      subscribeResize: () => () => undefined,
      subscribeSignals: (onSignal) => {
        signalHandlers.push(onSignal);
        return () => undefined;
      }, // no real process listeners in the default tests
      subscribeProcessExit: (onExit) => {
        exitHandlers.push(onExit);
        return () => undefined;
      },
      // Signal-oriented tests intentionally leave some drives pending after a simulated process exit. Keep their
      // default hermetic: dedicated G0 tests inject a recording POSIX lifecycle instead of leaking real listeners.
      jobControlLifecycle: INERT_JOB_CONTROL,
      onboardingTerminalLifecycle: INERT_ONBOARDING_TERMINAL,
      writeControl,
      exit: () => undefined,
      // A cancel-immediately onboarding prompter by DEFAULT, so a key-less resolver (e.g. the real keychain-backed
      // resolver over the mocked empty keychain) never invokes the REAL clack prompts in a test (which would render
      // to stdout / block). A wizard-specific test overrides this with a scripted flow.
      onboardingPrompter: CANCEL_ONBOARDING,
      ...overrides,
    };
    return { deps, unmount, writeControl, signalHandlers, exitHandlers };
  }

  it.each(['fresh', 'clear'] as const)(
    'joins and closes an unowned %s build when the pre-wiring key check throws',
    async (cut) => {
      let props: RootAppProps | undefined;
      let builds = 0,
        refuseKey = false;
      let releaseJoin = () => {};
      const joined = new Promise<void>((resolve) => {
        releaseJoin = resolve;
      });
      const closeMcp = vi.fn(async () => {}),
        closeOutputStore = vi.fn(async () => {});
      const resolver = scriptedResolver([textTurn('first answer')]);
      const { deps } = makeDeps(
        (value) => {
          props = value;
        },
        {
          providers: {
            ...resolver,
            hasKey: () => {
              if (refuseKey) {
                refuseKey = false;
                throw new Error('PRIVATE_PRE_WIRING_KEY_FAULT');
              }
              return true;
            },
          },
          buildSession: async (options) => {
            const built = await buildChatSession(options);
            builds++;
            if (builds !== (cut === 'fresh' ? 1 : 2)) return built;
            refuseKey = true;
            return { ...built, whenHostSafeToClose: () => joined, closeMcp, closeOutputStore };
          },
        },
      );
      const running = driveHome(deps);
      const ui = props;
      if (ui === undefined) throw new Error('Home not mounted');
      try {
        type(ui, 'first');
        ui.controller.handleKey('', ENTER);
        let previous = ui.controller.getSnapshot().session;
        if (cut === 'clear') {
          await vi.waitFor(() => expect(ui.controller.getSnapshot().mode).toBe('chat'), {
            timeout: WAIT_MS,
          });
          await vi.waitFor(() => expect(ui.controller.getSnapshot().submitBusy).toBe(false), {
            timeout: WAIT_MS,
          });
          previous = ui.controller.getSnapshot().session;
          ui.controller.handlePaste('/clear');
          ui.controller.handleKey('', ENTER);
        }
        await vi.waitFor(() => expect(builds).toBe(cut === 'fresh' ? 1 : 2), { timeout: WAIT_MS });
        await flush();
        expect(closeMcp).not.toHaveBeenCalled();
        expect(closeOutputStore).not.toHaveBeenCalled();
        releaseJoin();
        await vi.waitFor(() => expect(closeMcp).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
        expect(closeOutputStore).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(ui.controller.getSnapshot().submitBusy).toBe(false), {
          timeout: WAIT_MS,
        });
        expect(ui.controller.getSnapshot().session).toBe(previous);
      } finally {
        releaseJoin();
        if (ui.controller.getSnapshot().mode === 'chat') {
          ui.controller.handleKey('c', CTRL_C);
          ui.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
          await vi.waitFor(() => expect(ui.controller.getSnapshot().mode).toBe('home'), {
            timeout: WAIT_MS,
          });
        }
        ui.controller.handleKey('c', CTRL_C);
        ui.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
        await running;
      }
      expect(closeMcp).toHaveBeenCalledOnce();
    },
  );

  it('closes an unowned reseat build when reading its cost seed fails before wiring', async () => {
    let props: RootAppProps | undefined;
    const sessionStore = createSessionStore(client.db);
    const readCosts = sessionStore.loadSessionCostBreakdown.bind(sessionStore);
    let failCosts = false;
    vi.spyOn(sessionStore, 'loadSessionCostBreakdown').mockImplementation((id) => {
      if (failCosts) {
        failCosts = false;
        throw new Error('PRIVATE_RESEAT_COST_FAULT');
      }
      return readCosts(id);
    });
    const closeMcp = vi.fn(async () => {}),
      closeOutputStore = vi.fn(async () => {});
    const { deps } = makeDeps(
      (value) => {
        props = value;
      },
      {
        openSessionStore: () => ({ store: sessionStore, db: client.db, close: closeSpy }),
        buildResumedSession: async (options) => {
          const built = await buildResumedChatSession(options);
          failCosts = true;
          return { ...built, closeMcp, closeOutputStore };
        },
      },
    );
    const running = driveHome(deps);
    const ui = props;
    if (ui === undefined) throw new Error('Home not mounted');
    try {
      type(ui, 'first');
      ui.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(ui.controller.getSnapshot().mode).toBe('chat'), {
        timeout: WAIT_MS,
      });
      await vi.waitFor(() => expect(ui.controller.getSnapshot().submitBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      const original = ui.controller.getSnapshot().session;
      ui.controller.handleKey('/', {});
      type(ui, 'models');
      ui.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(ui.controller.getSnapshot().modelPicker).toBeDefined(), {
        timeout: WAIT_MS,
      });
      type(ui, 'claude-opus-4-8');
      ui.controller.handleKey('', ENTER);
      if (ui.controller.getSnapshot().modelPicker?.phase === 'effort')
        ui.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(closeMcp).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
      expect(closeOutputStore).toHaveBeenCalledOnce();
      expect(ui.controller.getSnapshot().session).toBe(original);
    } finally {
      if (ui.controller.getSnapshot().mode === 'chat') {
        ui.controller.handleKey('c', CTRL_C);
        ui.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
        await vi.waitFor(() => expect(ui.controller.getSnapshot().mode).toBe('home'), {
          timeout: WAIT_MS,
        });
      }
      ui.controller.handleKey('c', CTRL_C);
      ui.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await running;
    }
  });

  it.each([true, false])(
    'resumes safe display through Continue without changing Home workspace (inline=%s)',
    async (inline) => {
      let props: RootAppProps | undefined;
      const store = createSessionStore(client.db);
      const build = vi.fn(buildResumedChatSession);
      let available = true;
      const { deps } = makeDeps(
        (value) => {
          props = value;
        },
        {
          global: { ...global, noAltScreen: inline },
          openSessionStore: () => ({ store, db: client.db, close: closeSpy }),
          buildResumedSession: build,
          providers: {
            ...scriptedResolver([textTurn('first answer'), textTurn('safe answer')]),
            hasKey: () => available,
          },
        },
      );
      const running = driveHome(deps);
      await vi.waitFor(() => expect(props).toBeDefined(), { timeout: WAIT_MS });
      if (props === undefined) throw new Error('Home did not mount');
      const home = props;
      type(home, 'hello');
      home.controller.handleKey('', { return: true });
      await vi.waitFor(
        () => {
          expect(home.controller.getSnapshot().mode).toBe('chat');
          expect(home.controller.getSnapshot().submitBusy).toBe(false);
        },
        { timeout: WAIT_MS },
      );
      const first = home.controller.getSnapshot().session;
      if (first === undefined) throw new Error('missing first chat');
      await first.processLine('PRIVATE_CANONICAL', '@visible-safe');
      await first.processLine('/cancel');
      // The controller consumes the stop on its own next slash submission.
      type(home, '/cancel');
      home.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(home.controller.getSnapshot().mode).toBe('home'), {
        timeout: WAIT_MS,
      });
      available = false;
      home.controller.handleKey('', { downArrow: true });
      expect(home.controller.getSnapshot().stripFocus).toMatchObject({
        kind: 'session',
        id: first.sessionId,
      });
      const display = vi.spyOn(store, 'loadUserDisplayTexts');
      display.mockImplementationOnce(() => {
        throw new Error('PRIVATE_DISPLAY_FAILURE');
      });
      home.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(home.nativePrompt?.getSnapshot().kind).toBe('select'), {
        timeout: WAIT_MS,
      });
      expect(build).not.toHaveBeenCalled();
      expect(home.nativePrompt?.getSnapshot().selected).toBe(1); // Return is the safe default.
      home.nativePrompt?.input('', NATIVE_RETURN);
      await vi.waitFor(() => expect(home.controller.getSnapshot().nativeActionBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      expect(home.controller.getSnapshot().mode).toBe('home');
      home.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });
      await vi.waitFor(() => expect(home.controller.getSnapshot().nativeActionBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      const resumed = home.controller.getSnapshot().session;
      expect(resumed?.sessionId).toBe(first.sessionId);
      expect(
        resumed?.store
          .getSnapshot()
          .state.transcript.filter((row) => row.role === 'user')
          .map((row) => row.text),
      ).toEqual(['hello', '@visible-safe']);
      expect(JSON.stringify(resumed?.store.getSnapshot().state.transcript)).not.toContain(
        'PRIVATE_CANONICAL',
      );
      expect(build.mock.calls[0]?.[0].record.context.workingDir).toBe(realpathSync.native(cwd));
      expect(build.mock.calls[0]?.[0].deferMissingKey).toBe(true);
      expect(
        resumed?.store
          .getSnapshot()
          .state.transcript.some(
            (row) => row.role === 'notice' && row.text.includes('no usable key'),
          ),
      ).toBe(true);
      await resumed?.processLine('must not reach the provider');
      expect(
        store
          .loadFull(first.sessionId)
          ?.messages.some((message) =>
            JSON.stringify(message.content).includes('PRIVATE_CANONICAL'),
          ),
      ).toBe(true);
      // Return to Home and select a foreign context whose discovery column falsely claims the current cwd.
      type(home, '/cancel');
      home.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(home.controller.getSnapshot().mode).toBe('home'), {
        timeout: WAIT_MS,
      });
      const record = store.loadFull(first.sessionId)?.session;
      if (record === undefined) throw new Error('missing durable record');
      store.createSession({
        ...record,
        id: 'foreign-session',
        context: { ...record.context, workingDir: '/elsewhere' },
        updatedAt: '2099-01-01T00:00:00.000Z',
      });
      client.sqlite
        .prepare('UPDATE agent_sessions SET working_dir = ? WHERE id = ?')
        .run(realpathSync.native(cwd), 'foreign-session');
      type(home, '/resume');
      home.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(home.nativePrompt?.getSnapshot().kind).toBe('picker'), {
        timeout: WAIT_MS,
      });
      await vi.waitFor(
        () => expect(home.nativePrompt?.getSnapshot().options[0]?.value).toBe('foreign-session'),
        { timeout: WAIT_MS },
      );
      home.nativePrompt?.input('', NATIVE_RETURN);
      await vi.waitFor(() => expect(home.controller.getSnapshot().nativeActionBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      expect(home.controller.getSnapshot().notice).toContain('another directory');
      expect(build).toHaveBeenCalledTimes(1);
      home.controller.handleKey('c', { ctrl: true });
      home.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
      expect(await running).toBe(0);
    },
  );

  it('wires the /agents strip to the Home’s own project and the /resume picker’s own list: the same working directory, the same conversations', async () => {
    // An agent file in the project the Home is in, before the Home opens.
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(
      join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'),
      'id: reviewer\nname: Code Reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: You review code.\n',
    );
    let props: RootAppProps | undefined;
    const store = createSessionStore(client.db);
    const { deps } = makeDeps(
      (value) => {
        props = value;
      },
      { openSessionStore: () => ({ store, db: client.db, close: closeSpy }) },
    );
    const running = driveHome(deps);
    await vi.waitFor(() => expect(props).toBeDefined(), { timeout: WAIT_MS });
    if (props === undefined) throw new Error('Home did not mount');
    const home = props;
    // A real conversation of this directory, then one of another directory that is the newest of all.
    type(home, 'hello');
    home.controller.handleKey('', ENTER);
    await vi.waitFor(
      () => {
        expect(home.controller.getSnapshot().mode).toBe('chat');
        expect(home.controller.getSnapshot().submitBusy).toBe(false);
      },
      { timeout: WAIT_MS },
    );
    const first = home.controller.getSnapshot().session;
    if (first === undefined) throw new Error('missing first chat');
    await first.processLine('/cancel');
    type(home, '/cancel');
    home.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(home.controller.getSnapshot().mode).toBe('home'), {
      timeout: WAIT_MS,
    });
    const record = store.loadFull(first.sessionId)?.session;
    if (record === undefined) throw new Error('missing durable record');
    store.createSession({
      ...record,
      id: 'elsewhere-session',
      context: { ...record.context, workingDir: '/elsewhere' },
      updatedAt: '2099-01-01T00:00:00.000Z',
    });

    // What the /resume picker offers first.
    type(home, '/resume');
    home.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(home.nativePrompt?.getSnapshot().kind).toBe('picker'), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(
      () => expect(home.nativePrompt?.getSnapshot().options.length).toBeGreaterThan(0),
      {
        timeout: WAIT_MS,
      },
    );
    const offered = (home.nativePrompt?.getSnapshot().options ?? []).map((option) => option.value);
    home.nativePrompt?.input('', { ...NATIVE_RETURN, return: false, escape: true });
    await vi.waitFor(() => expect(home.controller.getSnapshot().nativeActionBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    expect(
      offered,
      'the picker offers this directory’s conversation and not the other one',
    ).toEqual([first.sessionId]);

    // What the /agents strip lists: the agent of the project, and the picker's conversations.
    type(home, '/agents');
    home.controller.handleKey('', ENTER);
    const screen = home.controller.getSnapshot().screen;
    const defined = screen?.kind === 'tab-host' ? screen.host.agents : undefined;
    expect(defined?.read.model.rows.map((row) => [row.slug, row.state])).toEqual([
      ['reviewer', 'ready'],
    ]);
    home.controller.handleKey('', { rightArrow: true });
    const next = home.controller.getSnapshot().screen;
    const sessions = next?.kind === 'tab-host' ? next.host.sessions : undefined;
    expect(
      sessions?.read.rows.map((row) => row.id),
      'the Sessions tab lists what the picker offers, in the same working directory',
    ).toEqual(offered);
    home.controller.handleKey('', { escape: true });
    home.controller.handleKey('c', { ctrl: true });
    home.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
    expect(await running).toBe(0);
  });

  it.each([false, true])(
    'observes actual passive Home view faults before bus recovery (fault=%s)',
    async (faulted) => {
      const f = invocationFixture();
      let captured: RootAppProps | undefined;
      let repliesAtClose = 0;
      let observedSessionId: string | undefined;
      const sessions = createSessionStore(client.db);
      closeSpy.mockImplementation(() => {
        const sessionId = observedSessionId;
        if (sessionId !== undefined)
          repliesAtClose =
            sessions.loadFull(sessionId)?.messages.filter((message) => message.role === 'assistant')
              .length ?? 0;
        client.sqlite.close();
      });
      const { deps, unmount } = makeDeps(
        (props) => {
          captured = props;
        },
        {
          invocation: f.invocation,
          providers: scriptedResolver([textTurn('first'), textTurn('second')]),
        },
      );
      const running = driveHome(deps);
      const completion = running.then(
        (value) => ({ value }),
        (cause: unknown) => ({ cause }),
      );
      let hits = 0;
      try {
        await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
        if (captured === undefined) throw new Error('Home did not mount');
        const props = captured;
        for (const character of 'hello') props.controller.handleKey(character, {});
        props.controller.handleKey('', ENTER);
        await vi.waitFor(
          () => {
            const id = props.controller.getSnapshot().session?.sessionId;
            expect(
              id === undefined
                ? []
                : sessions.loadFull(id)?.messages.filter((message) => message.role === 'assistant'),
            ).toHaveLength(1);
          },
          { timeout: WAIT_MS },
        );
        const session = props.controller.getSnapshot().session;
        if (session === undefined) throw new Error('Home did not create a session');
        observedSessionId = session.sessionId;
        const apply = session.store.apply.bind(session.store);
        vi.spyOn(session.store, 'apply').mockImplementation((event) => {
          if (faulted && event.type === 'session:turn_started') {
            hits++;
            throw new TypeError('PRIVATE_PASSIVE_HOME_FAULT');
          }
          apply(event);
        });
        await session.processLine('second input');
        expect(f.registry.termination !== undefined).toBe(faulted);
        if (!faulted) {
          props.controller.handleKey('c', CTRL_C);
          props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
          await flush();
          props.controller.handleKey('c', CTRL_C);
          props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
        }
        expect(await running).toBe(faulted ? 9 : 0);
        expect(hits).toBe(faulted ? 1 : 0);
        expect(repliesAtClose).toBe(faulted ? 1 : 2);
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(client.sqlite.open).toBe(false);
        expect(f.registry.activeOwners).toBe(0);
      } finally {
        unmount();
        await completion;
        vi.restoreAllMocks();
        if (client.sqlite.open) client.sqlite.close();
        rmSync(testHomeDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it('an init fault after the db is open (a throwing render/mount) still closes the db once', async () => {
    // The cleanup scope opens right after `opened`, and the inner finally guarantees the close even though the
    // ink mount throws — so a faulty render can never leak the db handle. (Bracketed-paste enable is ink 7's
    // usePaste now, not a mount-time writeControl, so the init fault is exercised via the mount itself.)
    const { deps } = makeDeps(() => undefined, {
      render: () => {
        throw new Error('ink mount failed');
      },
    });
    await expect(driveHome(deps)).rejects.toThrow('ink mount failed');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: 'owned (the product boundary)', owned: true },
    { path: 'unowned (an embedding)', owned: false },
  ])(
    'closes the hosted-run host and waits for it BEFORE the shared database closes — $path',
    async ({ owned }) => {
      const f = invocationFixture();
      const order: string[] = [];
      let releaseRun: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const run = new RunHost({
        invocation: f.invocation,
        io,
        global,
        db: client.db,
        // A temporary operator home, as every other Home in this file is given: this host starts no leg, but it
        // must never be able to reach the real one.
        homeDir: testHomeDir,
      });
      const closeRun = vi.spyOn(run, 'close').mockImplementation(async () => {
        order.push('run:close:start');
        await held;
        order.push('run:close:end');
      });
      closeSpy.mockImplementation(() => {
        order.push('db:close');
      });
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps(
        (props) => {
          captured = props;
        },
        { run, ...(owned ? { invocation: f.invocation } : {}) },
      );
      const running = driveHome(deps);
      await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
      const props = captured;
      if (props === undefined) throw new Error('Home not mounted');
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await vi.waitFor(() => expect(order).toContain('run:close:start'), { timeout: WAIT_MS });
      await flush();
      await flush();
      expect(order, 'HOME_RUN_HOST_JOIN_BEFORE_SHARED_DATABASE').toEqual(['run:close:start']);
      releaseRun();
      expect(await running).toBe(0);
      expect(order).toEqual(['run:close:start', 'run:close:end', 'db:close']);
      expect(closeRun).toHaveBeenCalledOnce();
    },
  );

  it('hands its run host to the exit guard: with a leg executing, two Ctrl+C ask instead of leaving, and Ctrl+Y cancels the leg and leaves', async () => {
    const f = invocationFixture();
    const run = new RunHost({
      invocation: f.invocation,
      io,
      global,
      db: client.db,
      // A temporary operator home, as every other Home in this file is given: this host starts no leg, but it must never be able to
      // reach the real one.
      homeDir: testHomeDir,
    });
    const idle: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
    const executing: RunHostSnapshot = {
      launching: false,
      active: { leg: 'start', runId: 'run-exit-guard', cancelling: false },
      last: undefined,
    };
    let live = true;
    vi.spyOn(run, 'snapshot').mockImplementation(() => (live ? executing : idle));
    const cancel = vi.spyOn(run, 'cancel').mockImplementation(() => {
      live = false; // the leg settles as soon as it is told to stop
      return true;
    });
    vi.spyOn(run, 'close').mockResolvedValue(undefined);
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps(
      (props) => {
        captured = props;
      },
      { run },
    );
    const running = driveHome(deps);
    await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
    const props = captured;
    if (props === undefined) throw new Error('Home not mounted');
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // a leg is executing: the second press asks
    await flush();
    expect(props.controller.getSnapshot().exitGuard).toBe('confirm');
    expect(settled, 'the Home is still there').toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    props.controller.bindHomeFrame(() => true); // the host measured the card on screen (this mount paints nothing)
    props.controller.handleKey('y', { ctrl: true }); // Ctrl+Y
    expect(cancel).toHaveBeenCalledOnce();
    expect(await running).toBe(0);
  });

  it('builds its own run host when none is injected, and a Home that never runs a workflow registers no workflow owner', async () => {
    const f = invocationFixture();
    const kinds: string[] = [];
    const register = f.registry.register.bind(f.registry);
    vi.spyOn(f.registry, 'register').mockImplementation((owner) => {
      kinds.push(owner.kind);
      return register(owner);
    });
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps(
      (props) => {
        captured = props;
      },
      { invocation: f.invocation },
    );
    expect(deps.run, 'the default is built by the Home, not injected').toBeUndefined();
    const running = driveHome(deps);
    await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
    const props = captured;
    if (props === undefined) throw new Error('Home not mounted');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C);
    expect(await running).toBe(0);
    expect(kinds, 'the Home registered owners, and none of them is a hosted leg').not.toContain(
      'workflow',
    );
    expect(kinds.length).toBeGreaterThan(0);
    expect(f.registry.activeOwners).toBe(0);
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it('observes an owned renderer failure before held host cleanup and closes the shared DB only after actual join', async () => {
    const f = invocationFixture();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured: RootAppProps | undefined;
    let builtCount = 0;
    const { deps, unmount } = makeDeps(
      (props) => {
        captured = props;
      },
      {
        invocation: f.invocation,
        buildSession: async (options) => {
          builtCount++;
          return { ...(await buildChatSession(options)), whenHostSafeToClose: () => held };
        },
      },
    );
    const drive = driveHome(deps).catch((cause: unknown) => cause);
    const props = captured;
    if (props === undefined) throw new Error('Home not mounted');
    type(props, 'synthetic first turn');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    const primary = new Error('PRIVATE_HOME_RENDERER_FAILURE');
    props.onRendererError?.(primary);
    await vi.waitFor(() => expect(unmount).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(closeSpy, 'HOME_ACTUAL_HOST_JOIN_BEFORE_SHARED_DATABASE').not.toHaveBeenCalled();
    props.controller.handlePaste('/clear');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(builtCount).toBe(1);
    release();
    expect(await drive).toBe(EXIT_CODES.infrastructureFailed);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('a throwing unmount on a clean exit stays best-effort — still resolves 0 and closes the db once', async () => {
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps(() => undefined, {
      render: (props) => {
        captured = props;
        return {
          unmount: () => {
            throw new Error('ink unmount failed');
          },
          waitUntilRenderFlush: () => Promise.resolve(),
          waitUntilExit: () => new Promise(() => {}),
        };
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success); // the throwing unmount did not corrupt the clean exit
    expect(closeSpy).toHaveBeenCalledTimes(1); // …and the db was still closed
  });

  it('a clean Home exit (Ctrl-C) resolves 0, closes the db once, and restores paste mode', async () => {
    let captured: RootAppProps | undefined;
    const { deps, unmount, writeControl } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome(deps);

    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');
    props.controller.handleKey('c', CTRL_C); // Ctrl-C on the Home ⇒ clean exit
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)

    expect(await drivePromise).toBe(EXIT_CODES.success);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
    // DECSET 2004 (bracketed paste) + mouse reporting are disabled on exit as belt-and-suspenders (guarding a signal
    // that skips ink's own unmount cleanup) — so a clean exit restores both native paste + mouse text-selection.
    const controls = writeControl.mock.calls.map((c) => c[0] as string);
    expect(controls).toContain(DISABLE_BRACKETED_PASTE);
    expect(controls).toContain(DISABLE_MOUSE);
  });

  it('a native database close failure preserves a clean Home exit and restored terminal controls (#22)', async () => {
    closeSpy.mockImplementation(() => {
      client.sqlite.close();
      throw new Error('SQLITE_IOERR_CLOSE /private/operator/history.db secret-token\x1b[2J');
    });
    let captured: RootAppProps | undefined;
    const writeErr = vi.fn();
    const { deps, unmount, writeControl, exitHandlers } = makeDeps((props) => (captured = props), {
      io: { ...io, writeErr },
    });
    const drivePromise = driveHome(deps);
    if (captured === undefined) throw new Error('the injected render was never invoked');
    captured.controller.handleKey('c', CTRL_C);
    captured.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)

    expect(await drivePromise).toBe(EXIT_CODES.success);
    expect(client.sqlite.open).toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(writeControl).toHaveBeenCalledWith(DISABLE_BRACKETED_PASTE);
    expect(writeControl).toHaveBeenCalledWith(DISABLE_MOUSE);
    expect(writeErr).toHaveBeenCalledExactlyOnceWith('warning: session store teardown failed\n');
    // The process-exit fallback shares the same close owner; a late callback must not repeat close or warning.
    for (const exit of exitHandlers) exit();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(writeErr).toHaveBeenCalledTimes(1);
  });

  it('a native database close failure preserves the original mount error and restored controls (#22)', async () => {
    const primary = new Error('ink mount primary failure');
    closeSpy.mockImplementation(() => {
      client.sqlite.close();
      throw new Error('SQLITE_IOERR_CLOSE /private/operator/history.db secret-token\x1b[2J');
    });
    const writeErr = vi.fn();
    const { deps, writeControl } = makeDeps(() => undefined, {
      io: { ...io, writeErr },
      render: () => {
        throw primary;
      },
    });

    await expect(driveHome(deps)).rejects.toBe(primary);
    expect(client.sqlite.open).toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(writeControl).toHaveBeenCalledWith(DISABLE_BRACKETED_PASTE);
    expect(writeControl).toHaveBeenCalledWith(DISABLE_MOUSE);
    expect(writeErr).toHaveBeenCalledExactlyOnceWith('warning: session store teardown failed\n');
  });

  it('MOUSE: the capture PORT exists by default, and `--no-mouse` withholds it (Step 5e/6g, ADR-0068 §e)', async () => {
    // The opt-out IS the safety mechanism this feature exists for. The unit tests pin `resolveMouseMode` in isolation;
    // this pins the ASSEMBLY — `deps.global.noMouse` → `resolveMouseMode` → whether `RootApp` gets a capture port at
    // all. A mis-threaded field would still be `boolean | undefined`, compile, and leave every test green
    // (Step-5e Opus review).
    //
    // Since Step 6g the port is what arms the mouse, not a mount-time write: capture belongs to the in-Home CHAT, and
    // the Home landing keeps the emulator's own click-drag selection.
    const exitCleanly = async (
      captured: () => RootAppProps | undefined,
      drivePromise: Promise<number>,
    ): Promise<void> => {
      const props = captured();
      if (props === undefined) throw new Error('the injected render was never invoked');
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await drivePromise;
    };

    // (a) the phase default hands `RootApp` a port, and NOTHING is captured until it is called.
    let onProps: RootAppProps | undefined;
    const on = makeDeps((p) => (onProps = p));
    const onDrive = driveHome(on.deps);
    expect(onProps?.setMouseCapture).toBeTypeOf('function');
    expect(on.writeControl.mock.calls.map((c) => c[0] as string)).not.toContain(ENABLE_MOUSE);

    onProps?.setMouseCapture?.(true); // the chat takes the screen
    expect(on.writeControl.mock.calls.map((c) => c[0] as string)).toContain(ENABLE_MOUSE);
    onProps?.setMouseCapture?.(false); // …and gives it back
    expect(on.writeControl.mock.calls.map((c) => c[0] as string)).toContain(DISABLE_MOUSE);
    await exitCleanly(() => onProps, onDrive);

    // (b) `--no-mouse` withholds the port entirely — there is nothing to arm, however the Home is driven.
    let offProps: RootAppProps | undefined;
    const off = makeDeps((p) => (offProps = p), { global: { ...global, noMouse: true } });
    const offDrive = driveHome(off.deps);
    expect(offProps?.setMouseCapture).toBeUndefined();
    await exitCleanly(() => offProps, offDrive);
    const controls = off.writeControl.mock.calls.map((c) => c[0] as string);
    expect(controls).not.toContain(ENABLE_MOUSE);
    expect(controls).toContain(DISABLE_MOUSE); // …and the teardown still disables, unconditionally
  });

  it('resolves the render mode into ink’s alternateScreen: default ON (4b-3), config opts out, --no-alt-screen wins (ADR-0068 §e)', async () => {
    // Capture the alt-screen decision driveHome passes to the (injected) render, driving a clean Ctrl-C exit so the
    // driveHome promise settles between cases. Exercises the resolver → render wiring end-to-end (flag + config).
    const resolveAlt = async (over: Partial<HomeDeps>): Promise<boolean> => {
      let alt = false;
      let props: RootAppProps | undefined;
      const { deps } = makeDeps(() => undefined, {
        render: (p, opts) => {
          props = p;
          alt = opts.alternateScreen;
          return {
            unmount: vi.fn(),
            waitUntilRenderFlush: () => Promise.resolve(),
            waitUntilExit: () => new Promise(() => {}),
          };
        },
        ...over,
      });
      const done = driveHome(deps);
      if (props === undefined) throw new Error('the injected render was never invoked');
      props.controller.handleKey('c', CTRL_C); // clean Home exit ⇒ driveHome resolves
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await done;
      return alt;
    };

    // 4b-3 phase default is alt-ON, so an absent config + no flag ⇒ full-screen (alternateScreen true).
    expect(await resolveAlt({})).toBe(true);

    // `[preferences].alt_screen = false` opts OUT ⇒ inline (alternateScreen false).
    const cfgOff = join(cwd, 'alt-screen-off.toml');
    writeFileSync(cfgOff, '[preferences]\nalt_screen = false\n');
    expect(await resolveAlt({ global: { ...global, configPath: cfgOff } })).toBe(false);

    // `--no-alt-screen` overrides even the default ⇒ inline (the per-invocation opt-out).
    expect(await resolveAlt({ global: { ...global, noAltScreen: true } })).toBe(false);
  });

  it('hands the controller a homeStore that reads the live (empty) strip snapshot', async () => {
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    const snap = props.controller.getSnapshot().snapshot;
    expect(snap.isEmpty).toBe(true);
    expect(snap.attention.gates).toEqual([]);

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('reconciles a crashed run BEFORE the first strip read (2.6.G liveness, #229)', async () => {
    // A run whose process died: `run:started` is durable, there is no terminal and no lease.
    const runs = createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'crashed', name: 'crashed', definitionJson: '{}' },
    });
    const runId = randomUUID();
    await runs.persistEvent(
      RunEventSchema.parse({
        type: 'run:started',
        runId,
        timestamp: '2026-11-05T10:00:00.000Z',
        sequenceNumber: 1,
        workflowId: await runs.resolveWorkflowId('crashed'),
        inputs: {},
        executionMode: 'local',
      }),
    );
    const order: string[] = [];
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps(
      (p) => {
        order.push('mount');
        captured = p;
      },
      {
        openSessionStore: () => ({
          store: createSessionStore(client.db),
          db: client.db,
          close: closeSpy,
          reconcileInterruptedRuns: async () => {
            order.push('reconcile');
            await reconcileInterruptedRuns(client.db, join(cwd, 'terminal-outbox.ndjson'));
          },
        }),
        // The #50 rule for an await before mount: the signal and exit nets are already registered.
        subscribeSignals: () => {
          order.push('signals');
          return () => undefined;
        },
        subscribeProcessExit: () => {
          order.push('exit-net');
          return () => undefined;
        },
      },
    );
    const drivePromise = driveHome(deps);
    await flush();
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    expect(order).toEqual(['signals', 'exit-net', 'reconcile', 'mount']);
    // The first snapshot already shows the run as failed, in "attention" — never as a `running` row.
    const snap = props.controller.getSnapshot().snapshot;
    expect(snap.attention.failedRuns.map((run) => run.runId)).toEqual([runId]);

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('startChat builds the default-agent session and persists its row; a clean return ends it', async () => {
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    mkdirSync(join(cwd, '.relavium'), { recursive: true });
    writeFileSync(join(cwd, '.relavium', 'project.toml'), '[defaults]\nmax_tokens_estimate = 17\n');
    const estimates: (number | undefined)[] = [];
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      invocation,
      buildSession: async (options) => {
        await witnessNativeToolProcess(
          options.nativeProcesses,
          invocation,
          options.cwd,
          estimates.length === 0 ? 4 : 5,
        );
        estimates.push(options.maxTokensEstimate);
        return buildChatSession(options);
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    type(props, 'hello');
    props.controller.handleKey('', ENTER); // submit ⇒ build + first turn
    await vi.waitFor(
      () => expect(invocation.registry.activeOwners, 'NATIVE_HOME_FRESH_FORWARDING').toBe(5),
      { timeout: WAIT_MS },
    );
    expect(props.controller.getSnapshot().mode).toBe('loading');
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });

    const sessions = createSessionStore(client.db);
    expect(sessions.listSessions({ limit: 10 })).toHaveLength(1); // the chat persisted its row
    await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });

    props.controller.handleKey('/', {});
    type(props, 'clear');
    // The filter also matches /cost's "clears held estimates" description, but the name that equals the query leads: Enter runs /clear.
    props.controller.handleKey('', ENTER);
    await vi.waitFor(
      () => expect(invocation.registry.activeOwners, 'NATIVE_HOME_FRESH_FORWARDING').toBe(6),
      { timeout: WAIT_MS },
    );
    await vi.waitFor(() => expect(estimates).toEqual([17, 17]), { timeout: WAIT_MS });
    expect(props.controller.getSnapshot().mode).toBe('chat');
    expect(estimates).toEqual([17, 17]);
    expect(sessions.listSessions({ limit: 10 })).toHaveLength(2);

    props.controller.handleKey('c', CTRL_C); // chat Ctrl-C ⇒ /cancel ⇒ back to Home
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ exit
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
    expect(sessions.listSessions({ limit: 10 })[0]?.status).toBe('ended');
  });

  it('keeps live tool details in the Home instance and clears them when returning Home', async () => {
    writeFileSync(join(cwd, 'notes.txt'), 'HOME_TOOL_DETAILS_READ_RESULT');
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((props) => (captured = props), {
      providers: scriptedResolver([
        [
          { type: 'text_delta', text: 'Before the read.' },
          { type: 'tool_call_start', id: 'home-provider-call', name: 'read_file' },
          {
            type: 'tool_call_delta',
            id: 'home-provider-call',
            argsJsonDelta: '{"path":"notes.txt"}',
          },
          { type: 'tool_call_end', id: 'home-provider-call' },
          stop('tool_use'),
        ],
        textTurn('After the read.'),
      ]),
    });
    const running = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('Home did not mount.');
    type(props, 'Read notes.txt');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    const session = props.controller.getSnapshot().session;
    if (session === undefined) throw new Error('Home did not publish the session.');
    const details = [...session.store.getSnapshot().toolDisplays.values()];
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      toolId: 'read_file',
      target: 'notes.txt',
      outcome: 'success',
    });
    expect(details[0]?.callId).not.toBe('home-provider-call');
    await session.processLine('/details');
    expect(session.store.getSnapshot().review?.kind).toBe('details');
    session.store.closeDetails();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('home'), {
      timeout: WAIT_MS,
    });
    expect(session.store.getSnapshot().toolDisplays.size).toBe(0);
    expect(session.store.getSnapshot().review).toBeUndefined();
    session.store.applyToolLiveEvent({
      phase: 'preview',
      callId: 'late-home-call',
      toolId: 'read_file',
      preview: { kind: 'operation', target: 'late-home-target', fields: [] },
    });
    expect(session.store.getSnapshot().toolDisplays.size).toBe(0);
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await running).toBe(EXIT_CODES.success);
  });

  it('retains both original native reservations when a pending clear build is superseded', async () => {
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    let captured: RootAppProps | undefined;
    const permits: (() => void)[] = [];
    const children: { close: () => Promise<void> }[] = [];
    let builds = 0;
    const { deps } = makeDeps((props) => (captured = props), {
      invocation,
      buildSession: async (options) => {
        if (builds++ === 0) return buildChatSession(options);
        const child = await holdNativeToolProcess(options.nativeProcesses, invocation, options.cwd);
        children.push(child);
        await new Promise<void>((resolve) => permits.push(resolve));
        const built = await buildChatSession(options);
        return {
          ...built,
          closeMcp: async () => {
            await child.close();
            await built.closeMcp?.();
          },
        };
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('Home was not mounted');
    try {
      type(props, 'hello');
      props.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('chat'), {
        timeout: WAIT_MS,
      });
      await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      const original = props.controller.getSnapshot().session;
      expect(original).toBeDefined();
      props.controller.handlePaste('/clear');
      props.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(permits, 'NATIVE_HOME_PENDING_FORWARDING').toHaveLength(1), {
        timeout: WAIT_MS,
      });
      expect(invocation.registry.activeOwners).toBe(6);
      expect(props.controller.getSnapshot().session).toBe(original); // first replacement still initializes
      props.controller.handleKey('c', CTRL_C); // sticky /clear starts a second replacement
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await vi.waitFor(() => expect(permits).toHaveLength(2), { timeout: WAIT_MS });
      expect(invocation.registry.activeOwners).toBe(8);
      permits[1]?.(); // second replacement wins while both native creations remain live
      await vi.waitFor(() => expect(props.controller.getSnapshot().session).not.toBe(original), {
        timeout: WAIT_MS,
      });
      const winner = props.controller.getSnapshot().session;
      expect(invocation.registry.activeOwners).toBe(7);
      permits[0]?.(); // stale completion may close only its own native creation
      await vi.waitFor(() => expect(invocation.registry.activeOwners).toBe(5), {
        timeout: WAIT_MS,
      });
      expect(props.controller.getSnapshot().session).toBe(winner);
      await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('home'), {
        timeout: WAIT_MS,
      });
      await vi.waitFor(() => expect(invocation.registry.activeOwners).toBe(3), {
        timeout: WAIT_MS,
      });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      expect(await drivePromise).toBe(EXIT_CODES.success);
    } finally {
      for (const permit of permits) permit();
      await Promise.all(children.map((child) => child.close()));
      await props.controller.teardownActive();
    }
  });

  it('binds the default Home editor to the original native registry', async () => {
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    const marker = join(cwd, 'home-editor-started');
    const release = join(cwd, 'home-editor-release');
    const script = fileURLToPath(new URL('../render/fixtures/native-editor.mjs', import.meta.url));
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((props) => (captured = props), {
      invocation,
      io: { ...io, env: { EDITOR: `"${process.execPath}" "${script}" "${marker}" "${release}"` } },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props?.suspendPort === undefined)
      throw new Error('default Home editor suspend port is missing');
    props.suspendPort.attach((body) => body());
    try {
      type(props, 'hello');
      props.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(props.controller.getSnapshot().session).toBeDefined(), {
        timeout: WAIT_MS,
      });
      await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      props.controller.handlePaste('/edit');
      props.controller.handleKey('', ENTER);
      await vi.waitFor(
        () => {
          expect(invocation.registry.activeOwners, 'NATIVE_HOME_EDITOR_FORWARDING').toBe(5);
          expect(readFileSync(marker, 'utf8')).toBe('ready\n');
        },
        { interval: 5, timeout: 3000 },
      );
    } finally {
      writeFileSync(release, 'release');
      await vi.waitFor(() => expect(invocation.registry.activeOwners).toBe(4), { timeout: 6000 });
      await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
        timeout: WAIT_MS,
      });
      props.suspendPort.attach(undefined);
    }
    expect(readFileSync(marker, 'utf8')).toBe('ready\nreleased\n');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('home'), {
      timeout: WAIT_MS,
    });
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  }, 10000);

  it.each(['unexpected', 'known-config-refusal'] as const)(
    'observes an owned /models default-write %s before inline picker recovery',
    async (mode) => {
      const f = invocationFixture();
      const configFile = join(cwd, 'owned-picker-config.toml');
      let captured: RootAppProps | undefined;
      const close = vi.fn(() => client.sqlite.close());
      const { deps } = makeDeps(
        (props) => {
          captured = props;
        },
        {
          invocation: f.invocation,
          global: { ...global, configPath: configFile },
          openSessionStore: () => ({ store: createSessionStore(client.db), db: client.db, close }),
        },
      );
      const drive = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('Home did not mount');
      try {
        props.controller.handleKey('/', {});
        type(props, 'models');
        props.controller.handleKey('', ENTER);
        await flush();
        expect(props.controller.getSnapshot().modelPicker?.entries.length).toBeGreaterThan(0);
        const postSealHints: Array<string | undefined> = [];
        const unsubscribe = props.controller.subscribe(() => {
          if (props.inputEnabled?.() === false)
            postSealHints.push(props.controller.getSnapshot().modelPicker?.hint);
        });
        if (mode === 'unexpected') {
          // This native entry is before the real writer's filesystem catch; no errno or arbitrary
          // error message is granted configuration-refusal provenance.
          vi.mocked(randomUUID).mockImplementationOnce(() => {
            throw new Error('PRIVATE_HOME_CONFIG_INVARIANT');
          });
        } else writeFileSync(configFile, '[preferences\n');
        props.controller.handleKey('', ENTER);
        if (props.controller.getSnapshot().modelPicker?.phase === 'effort')
          props.controller.handleKey('', ENTER);
        // Native preference publication now awaits visible rewrite acknowledgement.
        // Observe the settled write before checking owner disposition and inline recovery.
        await flush();
        if (mode === 'unexpected') {
          expect(randomUUID).toHaveBeenCalledOnce();
          expect(
            f.registry.observations.exitCode(),
            'HOME_DEFAULT_WRITE_FAULT_REACHES_ORIGINAL_OWNER',
          ).toBe(9);
          expect(f.registry.budget.deadline()).toBe(3000);
          expect(await drive).toBe(9);
          unsubscribe();
          expect(postSealHints, 'HOME_DEFAULT_WRITE_NO_POSTSEAL_PUBLICATION').toEqual([]);
        } else {
          unsubscribe();
          expect(postSealHints).toEqual([]);
          expect(props.controller.getSnapshot().modelPicker?.hint).toContain('could not save');
          expect(f.registry.termination).toBeUndefined();
          props.controller.handleKey('', { escape: true });
          props.controller.handleKey('', { escape: true });
          expect(props.controller.getSnapshot().modelPicker).toBeUndefined();
          props.controller.handleKey('c', CTRL_C);
          props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
          expect(await drive).toBe(0);
        }
      } finally {
        // Failed semantic assertions still close the actual drive before the fixture closes SQLite.
        props.controller.handleKey('', { escape: true });
        props.controller.handleKey('', { escape: true });
        props.controller.handleKey('c', CTRL_C);
        props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
        await drive;
      }
      expect(close).toHaveBeenCalledOnce();
      expect(client.sqlite.open).toBe(false);
      expect(f.registry.activeOwners).toBe(0);
    },
  );

  it('a /models write is picked up by the NEXT chat started in the SAME Home process (2.5.G S7 regression)', async () => {
    // The blocker Sonnet review caught: `startChat` closed over the load-once `config` snapshot, so a `/models`
    // write never reached a same-process chat even though the notice claimed "applies to your next chat session".
    // Drive the REAL port (real config write + real re-read) end-to-end and assert the next session binds the pick.
    const configFile = join(cwd, 'home-config.toml'); // a real, writable global config (the write + re-read target)
    let captured: RootAppProps | undefined;
    const builtDefaults: Array<string | undefined> = [];
    const builtEfforts: Array<ReasoningEffort | undefined> = [];
    const { deps } = makeDeps((p) => (captured = p), {
      global: { ...global, configPath: configFile },
      // Record the model + effort the session is built with, then delegate to the real builder (so the chat works).
      buildSession: (args) => {
        builtDefaults.push(args.chat.defaultModel);
        builtEfforts.push(args.chat.reasoningEffort);
        return buildChatSession(args);
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    // Open the /models picker via the Home palette, let its background refresh settle.
    props.controller.handleKey('/', {});
    type(props, 'models');
    props.controller.handleKey('', ENTER);
    await flush();
    const picker = props.controller.getSnapshot().modelPicker;
    if (picker === undefined || picker.entries.length === 0) {
      throw new Error('the /models picker did not open with catalog entries');
    }
    const chosen = picker.entries[picker.selected]?.modelId; // the highlighted model (filter empty ⇒ entries[0])
    if (chosen === undefined) throw new Error('no selected model');

    props.controller.handleKey('', ENTER); // accept the model
    // ADR-0066 §6: a reasoning-capable pick advances to the bare-Home effort sub-step (writes model + effort); a
    // non-reasoning one writes + closes directly. Accept the (default) effort too when the sub-step opened, and
    // capture the tier it will write (the opening highlight) so the next-chat re-read can be asserted.
    let writtenEffort: ReasoningEffort | undefined;
    const effortStep = props.controller.getSnapshot().modelPicker;
    if (effortStep?.phase === 'effort') {
      writtenEffort = REASONING_EFFORTS[effortStep.effortSelected]; // the tier the opening highlight accepts
      props.controller.handleKey('', ENTER); // accept the default effort ⇒ writeGlobalPreferences(chosen, effort)
    }
    await flush(); // the actual preference port acknowledges its visible notice before publication
    expect(props.controller.getSnapshot().modelPicker).toBeUndefined(); // picker closed on accept
    expect(props.controller.getSnapshot().notice).toContain('next chat session'); // honest success (write took effect)

    // Start a chat — the NEXT session MUST bind the just-chosen model (the fresh re-read), not a stale startup default.
    type(props, 'hello');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(props.controller.getSnapshot().mode).toBe('chat');
    expect(builtDefaults.at(-1)).toBe(chosen); // the regression assertion — a stale snapshot would NOT equal `chosen`
    // ADR-0066 §6 regression: the effort write (not only the model) must ALSO flow to the next chat in the SAME Home
    // process — a stale `config.chat.reasoningEffort` snapshot would silently drop the just-written effort default.
    if (writtenEffort !== undefined) {
      expect(builtEfforts.at(-1)).toBe(writtenEffort);
    }

    props.controller.handleKey('c', CTRL_C); // chat Ctrl-C ⇒ /cancel ⇒ back to Home
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('startChat couples the fresh default_model to the provider read WITH it — never a stale startup provider (review M5)', async () => {
    // The 404 trap: startup config binds default_model=gpt-4o + default_provider=openai. Mid-session the user
    // hand-edits the config to a DIFFERENT-family model (claude-sonnet-4-6) and does NOT add a provider line. The
    // next chat must NOT pair the fresh Claude model with the stale `openai` startup provider (which would dial the
    // OpenAI adapter with a Claude id → 404). With no provider on the fresh read, it is left undefined ⇒ inferred.
    const configFile = join(cwd, 'coupling-config.toml');
    writeFileSync(
      configFile,
      '[preferences]\ndefault_model = "gpt-4o"\ndefault_provider = "openai"\n',
    );
    let captured: RootAppProps | undefined;
    const builtModels: Array<string | undefined> = [];
    const builtProviders: Array<string | undefined> = [];
    const { deps } = makeDeps((p) => (captured = p), {
      global: { ...global, configPath: configFile },
      buildSession: (args) => {
        builtModels.push(args.chat.defaultModel);
        builtProviders.push(args.chat.defaultProvider);
        return buildChatSession(args);
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    // The user edits the global config mid-session: a new model of another family, no provider line.
    writeFileSync(configFile, '[preferences]\ndefault_model = "claude-sonnet-4-6"\n');

    type(props, 'hello');
    props.controller.handleKey('', ENTER); // submit ⇒ startChat ⇒ buildSession
    await flush();

    expect(builtModels.at(-1)).toBe('claude-sonnet-4-6'); // the fresh model took effect
    // THE FIX: the provider is NOT the stale startup 'openai' — it is undefined (⇒ inferred to anthropic), coupled
    // to the same read that supplied the model. Before M5 this was 'openai' and the turn 404'd.
    expect(builtProviders.at(-1)).toBeUndefined();

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('a chat that cannot start because the config broke mid-session says which file, from `~`, and not where it lives (RUNCORE-3)', async () => {
    const configFile = join(testHomeDir, '.relavium', 'config.toml');
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      global: { ...global, configPath: configFile },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    // The operator breaks the global config while the Home is open; the next chat cannot read it.
    mkdirSync(join(testHomeDir, '.relavium'), { recursive: true });
    writeFileSync(configFile, 'not = [valid');
    type(props, 'hello');
    props.controller.handleKey('', ENTER); // submit => startChat => the config read throws a ConfigError
    await flush();

    const banner = props.controller.getSnapshot().errorText ?? '';
    expect(banner.startsWith(`~${sep}.relavium${sep}config.toml: is not valid TOML`)).toBe(true);
    expect(banner, 'the operator home is not in the banner').not.toContain(testHomeDir);

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('ADR-0137: the in-Home chat is wired to the /permissions sheet through its own line handler, and a typed /permissions opens it', async () => {
    // The wired-but-dead field: a Home session built without `permissions` would still pass every controller test that hands the controller
    // a fake session, and `/permissions` would quietly answer "not available". This drives the REAL `startChat` and reads what it built.
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    type(props, 'hello');
    props.controller.handleKey('', ENTER); // submit ⇒ startChat ⇒ the real createChatLineHandler
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    const permissions = props.controller.getSnapshot().session?.permissions;
    expect(permissions?.surface, 'the session carries the port').toBe('chat');
    // The port reads the real store through the mocked keychain: no key was ever written, so the project's list is empty and readable.
    expect(permissions?.load().project).toEqual({ ok: true, rows: [] });
    expect(permissions?.load().session).toEqual([]);

    type(props, '/permissions');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().chatSheet).toBeDefined(), {
      timeout: WAIT_MS,
    });
    expect(permissionsSheetOf(props.controller.getSnapshot().chatSheet)?.surface).toBe('chat');
    props.controller.handleKey('', { escape: true });
    expect(props.controller.getSnapshot().chatSheet).toBeUndefined();

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C);
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('ADR-0140 §3: the in-Home chat is wired to the /agent sheet through its own line handler, and a typed /agent opens the built-in agent’s fields', async () => {
    // The wired-but-dead field again: a Home session built without `boundAgent` would still pass every controller test that hands the
    // controller a fake session, and `/agent` would be dispatched to a chat that prints a notice behind the sheet's back. This drives the
    // REAL `startChat` and reads what it built.
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    type(props, 'hello');
    props.controller.handleKey('', ENTER); // submit ⇒ startChat ⇒ the real createChatLineHandler
    await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    const view = props.controller.getSnapshot().session?.boundAgent?.();
    expect(view?.id, 'the session carries the view of its own agent').toBe('relavium-chat');
    expect(view?.builtIn).toBe(true);

    props.controller.handlePaste('/agent');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().chatSheet?.kind).toBe('agent'), {
      timeout: WAIT_MS,
    });
    const sheet = props.controller.getSnapshot().chatSheet;
    expect(sheet?.kind === 'agent' ? sheet.view.detail.model : undefined).toBe(view?.detail.model);
    expect(sheet?.kind === 'agent' ? sheet.view.sessionEffort : 'a sheet').toBeUndefined();
    props.controller.handleKey('', { escape: true });
    expect(props.controller.getSnapshot().chatSheet).toBeUndefined();

    // The reasoning effort the row shows is the SESSION's, the footer's: `/effort` changes the session and never the definition, so a view
    // made before it (or kept past it) would still say `not set`.
    props.controller.handlePaste('/effort high');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(
      () =>
        expect(props.controller.getSnapshot().session?.store.getSnapshot().reasoningEffort).toBe(
          'high',
        ),
      { timeout: WAIT_MS },
    );
    await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    props.controller.handlePaste('/agent');
    props.controller.handleKey('', ENTER);
    const afterEffort = props.controller.getSnapshot().chatSheet;
    expect(afterEffort?.kind === 'agent' ? afterEffort.view.sessionEffort : undefined).toBe('high');
    expect(
      afterEffort?.kind === 'agent' ? afterEffort.view.detail.reasoningEffort : 'a sheet',
    ).toBeUndefined();
    const drawn =
      afterEffort?.kind === 'agent'
        ? agentSheetLines(afterEffort.view, { columns: 80, terminalRows: 24 }).map(
            (line) => line.text,
          )
        : [];
    expect(drawn.join('\n')).toMatch(/Reasoning effort\s+high \(declared: not set\)/u);
    props.controller.handleKey('', { escape: true });
    expect(props.controller.getSnapshot().chatSheet).toBeUndefined();

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C);
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('ADR-0137 §3: the bare Home is wired to the Permissions tab over the real store, and a bare `relavium permissions` opens it and ends the run when it is closed', async () => {
    // The wired-but-dead field again: a Home built without the port would answer "not available" and every controller test would
    // still pass. This drives the REAL `driveHome` with `openPermissions` and reads what it built.
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome({ ...deps, openPermissions: true });
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');
    // The tab is already open on the project's list (no key was ever written: empty and readable), with no chat behind it.
    expect(props.controller.getSnapshot().mode).toBe('home');
    expect(tabSheetOf(props)?.surface).toBe('project');
    expect(tabSheetOf(props)?.snapshot.project).toEqual({
      ok: true,
      rows: [],
    });
    expect(tabSheetOf(props)?.snapshot.session).toBeUndefined();
    props.controller.handleKey('', { escape: true });
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('ADR-0137 §3: an ordinary Home opens no tab of its own, and the typed command opens the project list without ending the Home', async () => {
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');
    expect(tabSheetOf(props)).toBeUndefined();
    props.controller.handleKey('/', {});
    for (const ch of 'permissions') props.controller.handleKey(ch, {});
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(tabSheetOf(props)).toBeDefined(), {
      timeout: WAIT_MS,
    });
    props.controller.handleKey('', { escape: true });
    expect(props.controller.getSnapshot().mode).toBe('home');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C);
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  describe('ADR-0140 §2: the bare Home’s `/workflows` is the Defined tab over the project’s own catalog and pins', () => {
    const WORKFLOW = (id: string): string => `schema_version: '1.0'
workflow:
  id: ${id}
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;
    const definedOf = (props: RootAppProps) => {
      const screen = props.controller.getSnapshot().screen;
      return screen?.kind === 'tab-host' ? screen.host.defined : undefined;
    };
    /** A project with two workflows, `beta` pinned in the Home's own `history.db`. */
    function project(): void {
      mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
      writeFileSync(join(cwd, '.relavium', 'workflows', 'alpha.relavium.yaml'), WORKFLOW('alpha'));
      writeFileSync(join(cwd, '.relavium', 'workflows', 'beta.relavium.yaml'), WORKFLOW('beta'));
      createRunPinStore(client.db).pinItem({
        kind: 'workflow',
        projectRoot: commandGrantRoot(cwd, findProjectConfigDir(cwd, testHomeDir)),
        ref: 'beta',
        at: 1,
      });
    }
    /** A whole key as the host's `useInput` hands it to the prompt channel. */
    const channelKey = (over: Partial<Key>): Key => ({
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      pageDown: false,
      pageUp: false,
      home: false,
      end: false,
      return: false,
      escape: false,
      ctrl: false,
      shift: false,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      super: false,
      hyper: false,
      capsLock: false,
      numLock: false,
      ...over,
    });
    const typeLine = (props: RootAppProps, line: string): void => {
      props.controller.handlePaste(line);
      props.controller.handleKey('', ENTER);
    };

    it('lists the catalog the Home’s `/run` offers with the pins the Home’s database holds, pinned first, and starts no chat', async () => {
      project();
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p));
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      typeLine(props, '/workflows');
      await vi.waitFor(() => expect(definedOf(props)).toBeDefined(), { timeout: WAIT_MS });
      expect(definedOf(props)?.read.model.rows.map((row) => [row.slug, row.pinWord])).toEqual([
        ['beta', 'pinned'],
        ['alpha', 'unpinned'],
      ]);
      expect(props.controller.getSnapshot().session, 'no chat began').toBeUndefined();
      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('lists a workflow pinned under ANOTHER project as an `other-project` row, and names the pins the store holds: the Home hands the tab every pin, not only this project’s', async () => {
      // The wired-but-dead field once more: a Home built without the all-pins read would list this project's pins alone, the store's cap
      // would count pins the tab never showed, and every controller test would still pass.
      project();
      const otherRoot = mkdtempSync(join(tmpdir(), 'relavium-other-project-'));
      try {
        createRunPinStore(client.db).pinItem({
          kind: 'workflow',
          projectRoot: otherRoot,
          ref: 'elsewhere',
          at: 2,
        });
        // A run pin holds a slot of the store's cap too, and the tab lists none of it: the stored total must count it, so a read that fed the
        // tab only the workflow pins (the kind filtered away) would name two stored pins where the store holds three.
        createRunPinStore(client.db).pinItem({
          kind: 'run',
          projectRoot: '',
          ref: 'a1b2c3d4-0000-4000-8000-000000000001',
          at: 3,
        });
        let captured: RootAppProps | undefined;
        const { deps } = makeDeps((p) => (captured = p));
        const drivePromise = driveHome(deps);
        const props = captured;
        if (props === undefined) throw new Error('the injected render was never invoked');
        typeLine(props, '/workflows');
        await vi.waitFor(() => expect(definedOf(props)).toBeDefined(), { timeout: WAIT_MS });
        const rows = definedOf(props)?.read.model.rows ?? [];
        expect(rows.map((row) => [row.slug, row.state, row.pinned])).toEqual([
          ['beta', 'ready', true],
          ['elsewhere', 'other-project', true],
          ['alpha', 'ready', false],
        ]);
        // The pin of the other project is a row that can be removed from here, and the store's own total is what the read names.
        expect(definedOf(props)?.read.stored).toEqual({ total: 3, elsewhere: 2 });
        props.controller.handleKey('', { escape: true });
        props.controller.handleKey('c', CTRL_C);
        props.controller.handleKey('c', CTRL_C);
        expect(await drivePromise).toBe(EXIT_CODES.success);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it('x opens the export card over the real prepare, naming the destination in this directory; a No writes nothing', async () => {
      project();
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p));
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      const prompt = props.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt channel');
      typeLine(props, '/workflows');
      await vi.waitFor(() => expect(definedOf(props)).toBeDefined(), { timeout: WAIT_MS });
      props.controller.handleKey('x', {}); // the cursor is on `beta`, the pinned row
      await vi.waitFor(() => expect(prompt.getSnapshot().kind).toBe('chord'), { timeout: WAIT_MS });
      const card = prompt.getSnapshot();
      expect(card.message).toBe("Write workflow 'beta' to a file in this directory?");
      expect(card.details[0]).toBe('destination beta.relavium.yaml');
      prompt.input('n', channelKey({ ctrl: true }));
      await vi.waitFor(() => expect(definedOf(props)?.message).toBe('Nothing was written.'), {
        timeout: WAIT_MS,
      });
      expect(() => readFileSync(join(cwd, 'beta.relavium.yaml'), 'utf8')).toThrow();
      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('r opens the launch flow at that workflow, skipping the picker: its first card is the confirmation, and Ctrl+C leaves it with nothing started', async () => {
      project();
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p));
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      const prompt = props.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt channel');
      typeLine(props, '/workflows');
      await vi.waitFor(() => expect(definedOf(props)).toBeDefined(), { timeout: WAIT_MS });
      props.controller.handleKey('', { downArrow: true }); // `alpha`
      props.controller.handleKey('r', {});
      await vi.waitFor(() => expect(prompt.getSnapshot().message).toContain('Run alpha'), {
        timeout: WAIT_MS,
      });
      expect(prompt.getSnapshot().options.map((option) => option.label)).toEqual(['Yes', 'No']);
      prompt.input('c', channelKey({ ctrl: true }));
      await vi.waitFor(() => expect(definedOf(props)?.message).toBe('Run cancelled.'), {
        timeout: WAIT_MS,
      });
      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('r refuses a workflow whose file moved since the tab was read, through the Home’s own wiring: the row’s catalog path reaches the launch, and no prompt opens', async () => {
      // The wired-but-dead field once more: a Home that passed the slug alone (`launchRun: (slug) => runLaunch.open(slug)`) would find the
      // slug in its new file and open the form for it, and every controller test (which scripts the launch) would still pass.
      project();
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p));
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      const prompt = props.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt channel');
      typeLine(props, '/workflows');
      await vi.waitFor(() => expect(definedOf(props)).toBeDefined(), { timeout: WAIT_MS });
      // The tab has read `alpha` from `alpha.relavium.yaml`; the same workflow id is now declared by a file of another name.
      const workflows = join(cwd, '.relavium', 'workflows');
      renameSync(
        join(workflows, 'alpha.relavium.yaml'),
        join(workflows, 'alpha-moved.relavium.yaml'),
      );
      props.controller.handleKey('', { downArrow: true }); // `alpha`
      props.controller.handleKey('r', {});
      await vi.waitFor(
        () => expect(definedOf(props)?.message).toMatch(/is now in alpha-moved\.relavium\.yaml\./u),
        {
          timeout: WAIT_MS,
        },
      );
      expect(definedOf(props)?.message).toMatch(/^Not started\. Open the list again: alpha /u);
      expect(prompt.getSnapshot().active, 'no prompt was opened for the moved file').toBe(false);
      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });
  });

  describe('ADR-0140 §9: the bare Home’s `/import` and `/pricing` are wired to the Home’s own project, database and catalog', () => {
    const WORKFLOW = `schema_version: '1.0'
workflow:
  id: shared
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;
    /** A whole key as the host's `useInput` hands it to the prompt channel. */
    const nativeKey = (over: Partial<typeof NATIVE_RETURN>): typeof NATIVE_RETURN => ({
      ...NATIVE_RETURN,
      return: false,
      ...over,
    });
    const typeLine = (props: RootAppProps, line: string): void => {
      props.controller.handlePaste(line);
      props.controller.handleKey('', ENTER);
    };
    /** The Home, mounted, with its native prompt channel. */
    function openHome() {
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p));
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      const prompt = props.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt channel');
      return { props, prompt, drivePromise };
    }
    const leave = async (props: RootAppProps, drivePromise: Promise<unknown>): Promise<void> => {
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      expect(await drivePromise).toBe(EXIT_CODES.success);
    };

    it('/import asks for a path, shows the import over the Home’s own project directory, and a No writes nothing', async () => {
      mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
      mkdirSync(join(cwd, 'incoming'));
      writeFileSync(join(cwd, 'incoming', 'shared.relavium.yaml'), WORKFLOW);
      const { props, prompt, drivePromise } = openHome();
      typeLine(props, '/import');
      await vi.waitFor(() => expect(prompt.getSnapshot().kind).toBe('text'), { timeout: WAIT_MS });
      expect(prompt.getSnapshot().message).toBe(IMPORT_PATH_MESSAGE);
      expect(props.controller.getSnapshot().nativeActionBusy, 'the keyboard is the card’s').toBe(
        true,
      );
      prompt.paste('incoming/shared.relavium.yaml');
      prompt.input('', nativeKey({ return: true }));
      await vi.waitFor(() => expect(prompt.getSnapshot().kind).toBe('chord'), { timeout: WAIT_MS });
      const card = prompt.getSnapshot();
      expect(card.message).toBe("Import workflow 'shared' into this project?");
      expect(card.details[0]).toMatch(/^from\s+incoming\/shared\.relavium\.yaml$/u);
      expect(card.details[1]).toMatch(/^to\s+\.relavium\/workflows\/shared\.relavium\.yaml$/u);
      prompt.input('n', nativeKey({ ctrl: true }));
      await vi.waitFor(
        () => expect(props.controller.getSnapshot().notice).toBe('Nothing was written.'),
        { timeout: WAIT_MS },
      );
      expect(props.controller.getSnapshot().nativeActionBusy).toBe(false);
      expect(() =>
        readFileSync(join(cwd, '.relavium', 'workflows', 'shared.relavium.yaml'), 'utf8'),
      ).toThrow();
      await leave(props, drivePromise);
    });

    it('/pricing lists the catalog the Home’s `/models` lists and the providers its own database holds, and leaving it records nothing', async () => {
      // A provider registered in the very database the Home opened: the form's provider step lists it, so the port reads that handle.
      createProviderStore(client.db, { uuid: () => randomUUID(), now: () => 1 }).upsert({
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
      });
      const { props, prompt, drivePromise } = openHome();
      typeLine(props, '/pricing');
      await vi.waitFor(
        () => expect(prompt.getSnapshot().message).toBe('Model pricing: what do you want to do?'),
        { timeout: WAIT_MS },
      );
      expect(props.controller.getSnapshot().nativeActionBusy, 'the keyboard is the form’s').toBe(
        true,
      );
      expect(prompt.getSnapshot().options[0]?.label, 'the first option is the one chosen').toBe(
        PRICING_ACTION_SET,
      );
      prompt.input('', nativeKey({ return: true })); // the first option: Set a price
      await vi.waitFor(() => expect(prompt.getSnapshot().message).toBe('Which model?'), {
        timeout: WAIT_MS,
      });
      const options = prompt.getSnapshot().options.map((option) => option.label);
      expect(options.at(-1)).toBe('Another model…');
      expect(
        options.length,
        'the merged catalog the /models picker lists is behind the list: more than the one row for a model it does not show',
      ).toBeGreaterThan(1);
      prompt.input('', nativeKey({ upArrow: true })); // wraps to the last option: Another model…
      prompt.input('', nativeKey({ return: true }));
      await vi.waitFor(() => expect(prompt.getSnapshot().message).toBe('Model id'), {
        timeout: WAIT_MS,
      });
      prompt.paste('my-own-model');
      prompt.input('', nativeKey({ return: true }));
      await vi.waitFor(
        () => expect(prompt.getSnapshot().message).toBe("Which provider serves 'my-own-model'?"),
        { timeout: WAIT_MS },
      );
      expect(prompt.getSnapshot().options.map((option) => option.label)).toEqual(['openai']);
      prompt.input('c', nativeKey({ ctrl: true })); // leaves the form: nothing was recorded
      await vi.waitFor(
        () => expect(props.controller.getSnapshot().notice).toBe(PRICING_NOT_RECORDED),
        { timeout: WAIT_MS },
      );
      expect(props.controller.getSnapshot().nativeActionBusy).toBe(false);
      await leave(props, drivePromise);
    });
  });

  describe('ADR-0140 §3: `c` on an agent’s detail starts a chat bound to that agent, through the path `chat --agent` uses', () => {
    /** The agent of the project the detail names; its grant is the file's own. */
    const writeProjectAgent = (extra: readonly string[] = []): string => {
      mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
      const file = join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml');
      writeFileSync(
        file,
        [
          'id: reviewer',
          'name: Code Reviewer',
          'model: claude-sonnet-4-6',
          'provider: anthropic',
          'system_prompt: You review code.',
          'tools:',
          '  - read_file',
          '  - search_files',
          ...extra,
          '',
        ].join('\n'),
      );
      return file;
    };
    const nameOf = (request: LlmRequest | undefined): string[] =>
      (request?.tools ?? []).map((tool) => tool.name).sort();
    const settledChat = async (props: RootAppProps): Promise<void> => {
      await vi.waitFor(
        () => {
          expect(props.controller.getSnapshot().mode).toBe('chat');
          expect(props.controller.getSnapshot().submitBusy).toBe(false);
        },
        { timeout: WAIT_MS },
      );
    };
    /** The Home on the detail of `reviewer`, the build recorded (and, with `wrap`, rewritten) by the test. */
    async function onDetail(
      overrides: Partial<HomeDeps> = {},
      wrap: (options: BuildChatSessionOptions) => BuildChatSessionOptions = (options) => options,
    ) {
      const builds: BuildChatSessionOptions[] = [];
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), {
        buildSession: async (options) => {
          builds.push(options);
          return buildChatSession(wrap(options));
        },
        ...overrides,
      });
      const running = driveHome(deps);
      await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
      if (captured === undefined) throw new Error('the Home did not mount');
      const props = captured;
      type(props, '/agents');
      props.controller.handleKey('', ENTER);
      props.controller.handleKey('', ENTER);
      const screen = props.controller.getSnapshot().screen;
      expect(screen?.kind === 'tab-host' ? screen.host.agents?.detail?.slug : undefined).toBe(
        'reviewer',
      );
      return { props, running, builds };
    }
    const leaveHome = async (props: RootAppProps, running: Promise<number>): Promise<void> => {
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      expect(await running).toBe(EXIT_CODES.success);
    };

    it('binds that agent and no other: the tools the model is offered are the definition’s own, the file is the one the detail showed, and a `/clear` keeps the agent', async () => {
      const file = writeProjectAgent();
      // The agents list and the build share the Home's working directory (`deps.global.cwd`), which is not the process's: the list's
      // cwd-relative path finds the file only because the build resolves it against the same one.
      expect(process.cwd()).not.toBe(cwd);
      const { providers, requests } = capturingResolver([textTurn('first'), textTurn('second')]);
      const { props, running, builds } = await onDetail({ providers });
      props.controller.handleKey('c', {});
      await settledChat(props);

      // The build is the ordinary one with the agent the file declares: no reference to re-resolve, and the file named for the consent prompt.
      expect(builds).toHaveLength(1);
      expect(builds[0]?.agent?.id).toBe('reviewer');
      expect(builds[0]?.agentRef, 'nothing re-reads the file by a reference').toBeUndefined();
      expect(builds[0]?.mcpArtifact).toBe(file);
      expect(builds[0]?.consentGate, 'the Home’s consent gate is wired for it').toBeDefined();

      // The grant, observed where it matters: what the model is offered is exactly what the definition declares.
      const first = props.controller.getSnapshot().session;
      if (first === undefined) throw new Error('no chat opened');
      await first.processLine('hello', 'hello');
      expect(nameOf(requests[0])).toEqual(['read_file', 'search_files']);

      // `/clear` carries the agent the session holds: the same grant, no reading of a file again.
      props.controller.handlePaste('/clear');
      props.controller.handleKey('', ENTER);
      await vi.waitFor(
        () => expect(props.controller.getSnapshot().session?.sessionId).not.toBe(first.sessionId),
        { timeout: WAIT_MS },
      );
      await settledChat(props);
      expect(builds).toHaveLength(2);
      expect(builds[1]?.agent?.id).toBe('reviewer');
      expect(builds[1]?.agentRef).toBeUndefined();
      const second = props.controller.getSnapshot().session;
      if (second === undefined) throw new Error('no chat after /clear');
      await second.processLine('again', 'again');
      expect(nameOf(requests[1])).toEqual(['read_file', 'search_files']);

      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('home'), {
        timeout: WAIT_MS,
      });
      await leaveHome(props, running);
    });

    it('the `/agent` sheet of a chat started by `c` names the file the detail showed and marks the tool the Home’s chat does not wire; a `/clear` holds the definition and names no file', async () => {
      writeProjectAgent(['  - invoke_agent']);
      const { providers } = capturingResolver([textTurn('first')]);
      const { props, running } = await onDetail({ providers });
      props.controller.handleKey('c', {});
      await settledChat(props);

      // The label is the catalog's own, relative to the Home's working directory: never the absolute path the consent prompt names.
      const label = join('.relavium', 'agents', 'reviewer.agent.yaml');
      const view = props.controller.getSnapshot().session?.boundAgent?.();
      expect(view?.sourceLabel).toBe(label);
      expect(view?.sourceLabel).not.toContain(cwd);
      // The Home's chat can ask, so only the tool wired nowhere is marked.
      expect(view?.toolOffer).toEqual({ unwired: [false, false, true], declared: 3, offered: 2 });
      props.controller.handlePaste('/agent');
      props.controller.handleKey('', ENTER);
      const sheet = props.controller.getSnapshot().chatSheet;
      const drawn =
        sheet?.kind === 'agent'
          ? agentSheetLines(sheet.view, { columns: 80, terminalRows: 24 })
              .map((line) => line.text)
              .join('\n')
          : '';
      expect(drawn).toMatch(/File\s+\.relavium[\\/]agents[\\/]reviewer\.agent\.yaml/u);
      expect(drawn).toMatch(/Tools\s+2 of 3 offered: read_file, search_files,/u);
      expect(drawn).toContain('invoke_agent (not available in this chat)');
      props.controller.handleKey('', { escape: true });

      // A `/clear` rebinds the definition the session holds, with no file behind it: the view names none, and still marks the same tool.
      const first = props.controller.getSnapshot().session;
      props.controller.handlePaste('/clear');
      props.controller.handleKey('', ENTER);
      await vi.waitFor(
        () => expect(props.controller.getSnapshot().session?.sessionId).not.toBe(first?.sessionId),
        { timeout: WAIT_MS },
      );
      await settledChat(props);
      const cleared = props.controller.getSnapshot().session?.boundAgent?.();
      expect(cleared?.id).toBe('reviewer');
      expect(cleared?.sourceLabel).toBeUndefined();
      expect(cleared?.toolOffer?.unwired).toEqual([false, false, true]);

      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('home'), {
        timeout: WAIT_MS,
      });
      await leaveHome(props, running);
    });

    it('a Home that starts no agent still binds the built-in one: the same call with no reference', async () => {
      writeProjectAgent();
      const { providers, requests } = capturingResolver([textTurn('first')]);
      let captured: RootAppProps | undefined;
      const builds: BuildChatSessionOptions[] = [];
      const { deps } = makeDeps((p) => (captured = p), {
        providers,
        buildSession: (options) => {
          builds.push(options);
          return buildChatSession(options);
        },
      });
      const running = driveHome(deps);
      await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
      if (captured === undefined) throw new Error('the Home did not mount');
      type(captured, 'hello');
      captured.controller.handleKey('', ENTER);
      await settledChat(captured);
      expect(builds[0]?.agent).toBeUndefined();
      expect(builds[0]?.mcpArtifact).toBeUndefined();
      expect(nameOf(requests[0]).length, 'the built-in agent’s own, larger grant').toBeGreaterThan(
        2,
      );
      captured.controller.handleKey('c', CTRL_C);
      captured.controller.handleKey('c', CTRL_C);
      await vi.waitFor(() => expect(captured?.controller.getSnapshot().mode).toBe('home'), {
        timeout: WAIT_MS,
      });
      await leaveHome(captured, running);
    });

    it.each([
      [
        'vanished',
        (file: string) => rmSync(file),
        'The agent could not be started: its file is missing or cannot be read.',
      ],
      [
        'changed so that it no longer parses',
        (file: string) => writeFileSync(file, 'id: [unclosed\n'),
        'The agent could not be started: its definition is not valid.',
      ],
    ])(
      'an agent that %s between the list and `c` starts nothing: the landing says why, and nothing is half-open',
      async (_name, change, sentence) => {
        const file = writeProjectAgent();
        const { props, running, builds } = await onDetail();
        change(file);
        props.controller.handleKey('c', {});
        await vi.waitFor(() => expect(props.controller.getSnapshot().notice).toBe(sentence), {
          timeout: WAIT_MS,
        });
        const after = props.controller.getSnapshot();
        expect(after.mode).toBe('home');
        expect(after.nativeActionBusy).toBe(false);
        expect(after.session).toBeUndefined();
        expect(after.screen).toBeUndefined();
        expect(builds, 'no session was built').toHaveLength(0);
        expect(createSessionStore(client.db).listSessions({ limit: 10 })).toHaveLength(0);
        await leaveHome(props, running);
      },
    );

    it('a refusal through an OWNED Home is a refusal and not an infrastructure failure: the Home goes on, and leaves cleanly', async () => {
      const f = invocationFixture();
      const file = writeProjectAgent();
      const { props, running, builds } = await onDetail({ invocation: f.invocation });
      rmSync(file);
      props.controller.handleKey('c', {});
      await vi.waitFor(
        () =>
          expect(props.controller.getSnapshot().notice).toBe(
            'The agent could not be started: its file is missing or cannot be read.',
          ),
        { timeout: WAIT_MS },
      );
      expect(builds).toHaveLength(0);
      expect(f.registry.termination, 'a fixed refusal ends nothing').toBeUndefined();
      expect(props.controller.getSnapshot().mode).toBe('home');
      await leaveHome(props, running);
      expect(f.registry.activeOwners).toBe(0);
    });

    it('an agent edited between the list and `c` to a DIFFERENT, still valid definition starts nothing: the page the person read is no longer the file', async () => {
      const file = writeProjectAgent();
      const { props, running, builds } = await onDetail();
      // The same id and the same file, parsing as an agent: only the tool grant is wider than the page showed.
      writeProjectAgent(['  - write_file', '  - run_command']);
      expect(readFileSync(file, 'utf8')).toContain('run_command');
      props.controller.handleKey('c', {});
      await vi.waitFor(
        () =>
          expect(props.controller.getSnapshot().notice).toBe(
            'The agent changed since it was listed. Open the list again.',
          ),
        { timeout: WAIT_MS },
      );
      const after = props.controller.getSnapshot();
      expect(after.mode).toBe('home');
      expect(after.nativeActionBusy).toBe(false);
      expect(after.session).toBeUndefined();
      expect(after.screen).toBeUndefined();
      expect(builds, 'nothing was built, so nothing was bound').toHaveLength(0);
      expect(createSessionStore(client.db).listSessions({ limit: 10 })).toHaveLength(0);
      await leaveHome(props, running);
    });

    it('a symlink swapped in for the agent file, to a perfectly good agent outside the project, is refused and nothing is bound', async () => {
      const file = writeProjectAgent();
      const outside = mkdtempSync(join(tmpdir(), 'relavium-agent-outside-'));
      try {
        const target = join(outside, 'reviewer.agent.yaml');
        copyFileSync(file, target); // byte for byte the definition the page showed: only where it lives is wrong
        const { props, running, builds } = await onDetail();
        rmSync(file);
        symlinkSync(target, file);
        props.controller.handleKey('c', {});
        await vi.waitFor(
          () =>
            expect(props.controller.getSnapshot().notice).toBe(
              'The agent could not be started: its file is missing or cannot be read.',
            ),
          { timeout: WAIT_MS },
        );
        expect(props.controller.getSnapshot().mode).toBe('home');
        expect(props.controller.getSnapshot().session).toBeUndefined();
        expect(builds).toHaveLength(0);
        await leaveHome(props, running);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('an agent whose provider has no key starts nothing and says so, before anything is built', async () => {
      writeProjectAgent();
      let keyed = true;
      const resolver = scriptedResolver([textTurn('never')]);
      const { props, running, builds } = await onDetail({
        providers: { ...resolver, hasKey: () => keyed },
      });
      keyed = false;
      props.controller.handleKey('c', {});
      await vi.waitFor(
        () =>
          expect(props.controller.getSnapshot().notice).toBe(
            'The agent could not be started: its provider has no usable key (see /providers).',
          ),
        { timeout: WAIT_MS },
      );
      expect(props.controller.getSnapshot().mode).toBe('home');
      expect(builds).toHaveLength(0);
      await leaveHome(props, running);
    });

    it('an agent that declares a stdio MCP server goes through the consent every path uses, naming the file, and nothing spawns without it', async () => {
      const file = writeProjectAgent([
        'mcp_servers:',
        '  - id: fs',
        '    transport: stdio',
        `    command: ${JSON.stringify(process.execPath)}`,
      ]);
      // The REAL gate, with a prompt that declines: the card's subject is what the person would have been shown.
      const subjects: ConsentSubject[] = [];
      const gate = createConsentGate({
        io,
        global,
        homeDir: testHomeDir,
        nativeCard: true,
        prompt: (subject) => {
          subjects.push(subject);
          return Promise.resolve(false);
        },
      });
      const startMcpClient = vi.fn(() =>
        Promise.reject(new Error('a declined server must not start')),
      );
      const { props, running, builds } = await onDetail({}, (options) => ({
        ...options,
        consentGate: gate,
        startMcpClient,
      }));
      props.controller.handleKey('c', {});
      await vi.waitFor(
        () =>
          expect(props.controller.getSnapshot().notice).toBe(
            'The agent could not be started: its session could not be built.',
          ),
        { timeout: WAIT_MS },
      );
      expect(
        builds[0]?.consentGate,
        'the Home wired a gate of its own for the build',
      ).toBeDefined();
      expect(subjects, 'one decision for the one server').toHaveLength(1);
      expect(subjects[0]?.serverId).toBe('fs');
      expect(subjects[0]?.artifact, 'the card names the file the agent was read from').toBe(file);
      expect(startMcpClient, 'a declined server never spawns').not.toHaveBeenCalled();
      expect(props.controller.getSnapshot().mode).toBe('home');
      expect(props.controller.getSnapshot().session).toBeUndefined();
      await leaveHome(props, running);
    });
  });

  describe('ADR-0140 §2, §5: the bare Home’s History tab is the Home’s own database, pins and outbox', () => {
    const historyOf = (props: RootAppProps) => {
      const screen = props.controller.getSnapshot().screen;
      return screen?.kind === 'tab-host' ? screen.host.history : undefined;
    };

    it('lists this project’s finished runs, pins one under its full id into the Home’s database, and opens its detail through the real loader', async () => {
      // The wired-but-dead field once more: a Home built without the History port would say the history cannot be read, and every
      // controller test would still pass. This drives the REAL `driveHome` over a run seeded into the database it was handed.
      const runId = await seedRun(client.db, {
        slug: 'wf',
        runId: '0a1b2c3d-0000-4000-8000-0000000000aa',
        state: 'completed',
        atMs: 1_750_000_000_000 - 60_000,
      });
      client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(cwd, runId);
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p));
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      expect(props.controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
      const tab = historyOf(props);
      expect(tab?.phase).toBe('ready');
      expect(tab?.read?.rows.map((entry) => entry.kind === 'run' && entry.row.id)).toEqual([runId]);

      props.controller.handleKey('p', {});
      expect(createRunPinStore(client.db).listPins({ kind: 'run' })).toMatchObject([
        { kind: 'run', projectRoot: '', ref: runId },
      ]);
      expect(historyOf(props)?.read?.pinned).toHaveLength(1);

      props.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(historyOf(props)?.detail?.phase).toBe('ready'), {
        timeout: WAIT_MS,
      });
      expect(historyOf(props)?.detail?.read?.model.header.runId).toBe(runId);
      expect(historyOf(props)?.detail?.read?.terminalHeld, 'the outbox is empty').toBe(false);

      props.controller.handleKey('', { escape: true }); // back to the list
      props.controller.handleKey('', { escape: true }); // the screen closes
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });
  });

  describe('ADR-0140 §2: the bare Home’s Active tab is the Home’s own database, outbox and hosted leg', () => {
    const activeOf = (props: RootAppProps) => {
      const screen = props.controller.getSnapshot().screen;
      return screen?.kind === 'tab-host' ? screen.host.active : undefined;
    };
    const classOf = (props: RootAppProps, runId: string): string | undefined =>
      activeOf(props)?.rows.find((row) => row.runId === runId)?.class;
    /** A terminal event as the outbox holds it: the run is over, and the log has no end for it. */
    const terminalOf = (runId: string): RunEvent => ({
      type: 'run:completed',
      runId,
      sequenceNumber: 9,
      timestamp: '2026-11-23T10:00:00.000Z',
      outputs: {},
      totalTokensUsed: { input: 1, output: 1 },
      totalCostMicrocents: 5,
      durationMs: 10,
    });

    it('lists the hosted leg and a run whose end is held, from the Home’s own outbox, and re-reads when the leg ends: the change token carries the hosted run', async () => {
      // The wired-but-dead fields once more: the reader's `hostedRunId` and `listHeld`, and the token's `hostedRunId`. Each is a closure in
      // `driveHome`, and a Home built without any of them would still pass every controller test, which scripts them.
      const hosted = await seedRun(client.db, {
        slug: 'wf',
        runId: 'hosted-run',
        state: 'running',
        atMs: 1_750_000_000_000 - 5_000,
      });
      const held = await seedRun(client.db, {
        slug: 'wf',
        runId: 'held-run',
        state: 'running',
        atMs: 1_750_000_000_000 - 4_000,
      });
      // Both ends are in the outbox, as a leg that was cut off at its end leaves them; the hosted leg is still `hosted` (precedence).
      mkdirSync(join(testHomeDir, '.relavium'), { recursive: true });
      const outbox = createFileTerminalOutbox(terminalOutboxPath(testHomeDir));
      await outbox.put(terminalOf(hosted));
      await outbox.put(terminalOf(held));

      const f = invocationFixture();
      const run = new RunHost({
        invocation: f.invocation,
        io,
        global,
        db: client.db,
        homeDir: testHomeDir,
      });
      const idle: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
      const executing: RunHostSnapshot = {
        launching: false,
        active: { leg: 'start', runId: hosted, cancelling: false },
        last: undefined,
      };
      let live = true;
      vi.spyOn(run, 'snapshot').mockImplementation(() => (live ? executing : idle));
      vi.spyOn(run, 'cancel').mockImplementation(() => {
        live = false;
        return true;
      });
      vi.spyOn(run, 'close').mockResolvedValue(undefined);
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), { run });
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      expect(props.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
      await vi.waitFor(() => expect(activeOf(props)?.phase).toBe('ready'), { timeout: WAIT_MS });
      expect(classOf(props, hosted), 'the leg this Home executes').toBe('hosted');
      expect(classOf(props, held), 'a run whose terminal sits in the Home’s own outbox').toBe(
        'held',
      );

      // The leg ends. Nothing is written to the database, so only the token's hosted run tells the poll that what the tab labels moved: the
      // next tick (the poll's own, on the real clock) reads again, and the run is no longer the leg this Home executes.
      live = false;
      await vi.waitFor(() => expect(classOf(props, hosted)).toBe('held'), { timeout: WAIT_MS });
      expect(classOf(props, held)).toBe('held');

      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });
  });

  describe('ADR-0137 §3: the bare Home’s sheet reads the project’s own store, afresh every time', () => {
    const memoryKeychain = (): KeychainStore => {
      const entries = new Map<string, string>();
      return {
        get: (account) => entries.get(account) ?? null,
        set: (account, secret) => void entries.set(account, secret),
        delete: (account) => entries.delete(account),
      };
    };
    /** The store a chat and `relavium permissions` would open for this working directory: the same root, home and key. */
    const projectStore = (keychain: KeychainStore): CommandGrantStore =>
      createCommandGrantStore({
        homeDir: testHomeDir,
        projectRoot: commandGrantRoot(global.cwd, findProjectConfigDir(global.cwd, testHomeDir)),
        keychain,
        findProgram: (name) => Promise.resolve(`/usr/bin/${name}`),
      });
    const rowLabels = (props: RootAppProps): readonly string[] => {
      const project = tabSheetOf(props)?.snapshot.project;
      return project?.ok === true ? project.rows.map((row) => row.label) : [];
    };

    it('lists the grants remembered for THIS project under THIS home: a wrong root or home would list nothing, silently', async () => {
      const keychain = memoryKeychain();
      await projectStore(keychain).remember(['npm', 'test']);
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), { keychain });
      const drivePromise = driveHome({ ...deps, openPermissions: true });
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      expect(rowLabels(props)).toEqual(['npm, 1 argument']);
      props.controller.handleKey('', { escape: true });
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('reads a new store on every open: a key another terminal replaced does not leave the long-lived Home listing nothing', async () => {
      const keychain = memoryKeychain();
      await projectStore(keychain).remember(['npm', 'test']);
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), { keychain });
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      const openFromPalette = (): void => {
        props.controller.handleKey('/', {});
        for (const ch of 'permissions') props.controller.handleKey(ch, {});
        props.controller.handleKey('', ENTER);
      };
      openFromPalette();
      await vi.waitFor(() => expect(rowLabels(props)).toEqual(['npm, 1 argument']), {
        timeout: WAIT_MS,
      });
      props.controller.handleKey('', { escape: true });
      // Another terminal: `relavium permissions revoke --all` (the file and the digest key go), then a chat remembers something new.
      projectStore(keychain).revokeAll();
      await projectStore(keychain).remember(['node', '--version']);
      openFromPalette();
      await vi.waitFor(() => expect(rowLabels(props)).toEqual(['node, 1 argument']), {
        timeout: WAIT_MS,
      });
      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('withdraws through the Home’s own wrapper, end to end: `d`, then `Enter`, removes the grant from the store a chat reads', async () => {
      const keychain = memoryKeychain();
      await projectStore(keychain).remember(['npm', 'test']);
      expect(projectStore(keychain).list()).toMatchObject({
        ok: true,
        grants: [{ program: 'npm' }],
      });
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), { keychain });
      const drivePromise = driveHome({ ...deps, openPermissions: true });
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      expect(rowLabels(props)).toEqual(['npm, 1 argument']);
      // The controller runs on the real clock here. The sheet answers an early `d` with its own wait note (which is not typing) and arms
      // on the first one that lands after it settled, so `d` is pressed until the sheet says the question is up. An `Enter` that comes
      // before the question's dwell drops the question instead, so it cannot be retried: it is waited out on a timer, past the constant.
      await vi.waitFor(
        () => {
          props.controller.handleKey('d', {});
          expect(tabSheetOf(props)?.armed).toBe(true);
        },
        { timeout: WAIT_MS, interval: 25 },
      );
      await new Promise((resolve) =>
        setTimeout(resolve, SHEET_CONFIRM_DWELL_MS + SETTLE_MARGIN_MS),
      );
      props.controller.handleKey('', ENTER);
      expect(tabSheetOf(props)?.message?.tone).toBe('done');
      expect(rowLabels(props)).toEqual([]);
      expect(projectStore(keychain).list()).toEqual({ ok: true, grants: [] });
      props.controller.handleKey('', { escape: true });
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('finds the project directory again on every read, as a chat does: a `.relavium/` that appeared since the Home started changes the root', async () => {
      const keychain = memoryKeychain();
      const sub = join(cwd, 'sub');
      mkdirSync(sub);
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), {
        keychain,
        global: { ...global, cwd: sub },
      });
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      // While the Home runs a project directory appears above its working directory (a checkout, a pull, another terminal's `init`); a
      // chat built from this Home would key its grants by that root, so a grant remembered there is what the Home must list.
      mkdirSync(join(cwd, '.relavium'));
      await createCommandGrantStore({
        homeDir: testHomeDir,
        projectRoot: commandGrantRoot(sub, findProjectConfigDir(sub, testHomeDir)),
        keychain,
        findProgram: (name) => Promise.resolve(`/usr/bin/${name}`),
      }).remember(['npm', 'test']);
      props.controller.handleKey('/', {});
      for (const ch of 'permissions') props.controller.handleKey(ch, {});
      props.controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(rowLabels(props)).toEqual(['npm, 1 argument']), {
        timeout: WAIT_MS,
      });
      props.controller.handleKey('', { escape: true });
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C);
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });

    it('is not a first run: a bare `relavium permissions` on a Home with no provider key opens no setup card over the sheet', async () => {
      const keylessResolver: ProviderResolver = {
        resolveProvider: () => undefined,
        keyFor: () => {
          throw new Error('no key');
        },
      };
      const capture: { props?: RootAppProps } = {};
      const { deps } = makeDeps(
        (p) => {
          capture.props = p;
        },
        { providers: keylessResolver, keychain: memoryKeychain() },
      );
      // The production setup is the in-Home card, started when the renderer is ready, unless a legacy prompter is injected: take it out.
      const { onboardingPrompter, ...production } = deps;
      void onboardingPrompter;
      const drivePromise = driveHome({ ...production, openPermissions: true });
      const props = capture.props;
      if (props === undefined) throw new Error('the injected render was never invoked');
      await flush();
      expect(props.nativePrompt?.getSnapshot().active, 'no card over the sheet').toBe(false);
      expect(tabSheetOf(props)).toBeDefined();
      props.controller.handleKey('', { escape: true });
      expect(await drivePromise).toBe(EXIT_CODES.success);
    });
  });

  it('ADR-0132: the Home gives a fresh chat AND a /models-reseated chat the question delegate, each bound to its own store', async () => {
    // The Home is always a terminal with a person at it, and its fresh and reseat builders are separate call sites: a missing
    // option or a missing `bind` on either leaves that session unable to ask. Asking through the delegate the session was
    // built with must draw a card on the store the Home put on screen.
    const askRequest: AskUserRequest = {
      questions: [
        {
          header: 'Pick',
          question: 'Which file?',
          multiSelect: false,
          options: [
            { label: 'alpha.ts', description: 'The first file' },
            { label: 'beta.ts', description: 'The second file' },
          ],
        },
      ],
    };
    // The question delegate AND the continue-checkpoint hook come from one option (ADR-0136 §2): both must draw their card on the
    // store the Home put on screen, on the fresh build and on the reseat.
    const drawsACard = async (
      store: ChatStoreController | undefined,
      wired:
        | { askUser?: AskUserDelegate | undefined; checkpoint?: ToolRoundLimitHook | undefined }
        | undefined,
    ): Promise<boolean> => {
      if (store === undefined || wired?.askUser === undefined || wired.checkpoint === undefined)
        return false;
      const questionAbort = new AbortController();
      const asked = wired.askUser(askRequest, questionAbort.signal).catch(() => undefined);
      const questionDrawn = store.getSnapshot().question?.request === askRequest;
      questionAbort.abort();
      await asked;
      const checkpointAbort = new AbortController();
      const held = wired
        .checkpoint({ rounds: 1, interval: 1 }, checkpointAbort.signal)
        .catch(() => undefined);
      const checkpointDrawn = store.getSnapshot().checkpoint?.rounds === 1;
      checkpointAbort.abort();
      await held;
      return questionDrawn && checkpointDrawn;
    };
    let freshAsk:
      | { askUser?: AskUserDelegate | undefined; checkpoint?: ToolRoundLimitHook | undefined }
      | undefined;
    let reseatAsk:
      | { askUser?: AskUserDelegate | undefined; checkpoint?: ToolRoundLimitHook | undefined }
      | undefined;
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      providers: scriptedResolver([textTurn('sonnet reply'), textTurn('opus reply')]),
      buildSession: (options) => {
        freshAsk = { askUser: options.askUser, checkpoint: options.checkpoint };
        return buildChatSession(options);
      },
      buildResumedSession: (options) => {
        reseatAsk = { askUser: options.askUser, checkpoint: options.checkpoint };
        return buildResumedChatSession(options);
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');
    type(props, 'first');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().session).toBeDefined(), {
      timeout: WAIT_MS,
    });
    const first = props.controller.getSnapshot().session;
    expect(freshAsk).toBeDefined();
    expect(await drawsACard(first?.store, freshAsk)).toBe(true);

    props.controller.handleKey('/', {});
    type(props, 'models');
    props.controller.handleKey('', ENTER);
    await flush();
    type(props, 'claude-opus-4-8');
    props.controller.handleKey('', ENTER);
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().session).not.toBe(first), {
      timeout: WAIT_MS,
    });
    expect(reseatAsk).toBeDefined();
    expect(await drawsACard(props.controller.getSnapshot().session?.store, reseatAsk)).toBe(true);

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('in-Home /models reseat: the REAL reseatChat resumes the session under the switched model, carrying the transcript (ADR-0059)', async () => {
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    mkdirSync(join(cwd, '.relavium'), { recursive: true });
    writeFileSync(join(cwd, '.relavium', 'project.toml'), '[defaults]\nmax_tokens_estimate = 17\n');
    const freshEstimates: (number | undefined)[] = [];
    const resumedEstimates: (number | undefined)[] = [];
    // Exercises the REAL drive-home reseatChat builder (loadFull → swapAgentModel → buildResumedChatSession → seeded
    // store) end-to-end — not the mocked controller-level test — pinning the build-first swap over the same sessionId.
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      invocation,
      providers: scriptedResolver([textTurn('sonnet reply'), textTurn('opus reply')]),
      buildSession: async (options) => {
        await witnessNativeToolProcess(options.nativeProcesses, invocation, options.cwd, 4);
        freshEstimates.push(options.maxTokensEstimate);
        return buildChatSession(options);
      },
      buildResumedSession: async (options) => {
        await witnessNativeToolProcess(
          options.nativeProcesses,
          invocation,
          options.record.context.workingDir,
          5,
        );
        resumedEstimates.push(options.maxTokensEstimate);
        return buildResumedChatSession(options);
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    // Start a chat (bound to the default claude-sonnet-4-6) + run one turn so the transcript persists.
    type(props, 'first');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(props.controller.getSnapshot().session).toBeDefined(), {
      timeout: WAIT_MS,
    });
    expect(props.controller.getSnapshot().mode).toBe('chat');
    const oldSession = props.controller.getSnapshot().session;
    const sessionId = oldSession?.sessionId ?? '';
    expect(sessionId).not.toBe('');

    // ADR-0140 §3: `/agent` on the session as it starts shows the sonnet pair (no effort tier). Opened BEFORE the reseat on purpose: a view
    // kept past the swap would be read here first, and the reseated chat would then show this one.
    props.controller.handlePaste('/agent');
    props.controller.handleKey('', ENTER);
    const before = props.controller.getSnapshot().chatSheet;
    expect(before?.kind === 'agent' ? before.view.detail.model : undefined).toBe(
      'claude-sonnet-4-6',
    );
    expect(
      before?.kind === 'agent' ? before.view.detail.reasoningEffort : 'a sheet',
    ).toBeUndefined();
    props.controller.handleKey('', { escape: true });
    expect(props.controller.getSnapshot().chatSheet).toBeUndefined();

    // Open the reseat picker from the chat palette, filter to a DIFFERENT available model (opus), accept.
    props.controller.handleKey('/', {});
    type(props, 'models');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(props.controller.getSnapshot().modelPicker).toBeDefined();
    // Filter to EXACTLY one model. `'opus'` matched a single row while the shipped table had twelve; the generated
    // catalog carries eighty, and several are Opus — so a substring filter now selects whichever sorts first, and
    // the test would silently be asserting about a different model than it names (ADR-0071 §1).
    type(props, 'claude-opus-4-8');
    props.controller.handleKey('', ENTER); // opus is reasoning-capable ⇒ the ADR-0066 effort sub-step (not an
    // immediate reseat). The picker advanced to the effort phase over the pending model.
    const effortPicker = props.controller.getSnapshot().modelPicker;
    expect(effortPicker?.phase).toBe('effort');
    expect(effortPicker?.pending?.modelId).toBe('claude-opus-4-8');
    props.controller.handleKey('', ENTER); // apply the highlighted tier (default 'medium') ⇒ the REAL reseatChat
    await vi.waitFor(
      () => expect(invocation.registry.activeOwners, 'NATIVE_HOME_RESEAT_FORWARDING').toBe(6),
      { timeout: WAIT_MS },
    );
    await vi.waitFor(() => expect(resumedEstimates).toEqual([17]), { timeout: WAIT_MS });
    await vi.waitFor(() => expect(props.controller.getSnapshot().session).not.toBe(oldSession), {
      timeout: WAIT_MS,
    });

    // The session was reseated: a NEW session object, the SAME sessionId, bound to opus, carrying the prior turn.
    const reseated = props.controller.getSnapshot().session;
    expect(reseated).not.toBe(oldSession); // swapped in a new instance
    expect(reseated?.sessionId).toBe(sessionId); // a reseat CONTINUES the same session (unlike /clear's new id)
    expect(reseated?.store.getSnapshot().state.model).toBe('claude-opus-4-8'); // rebound to the picked model
    expect(reseated?.store.getSnapshot().state.turnCount).toBe(1); // the prior turn carried
    expect(freshEstimates).toEqual([17]);
    expect(resumedEstimates).toEqual([17]);

    // F1 (2.6.C) — the RENDERED conversation carries too, which is what this test's name always claimed and never
    // checked. Before the fix the reseat seeded `transcript: []`, so on the full-screen renderer (whose viewport
    // windows the store's in-memory transcript, with no native scrollback behind it) the whole conversation vanished
    // from the screen. The durable row was always intact; this asserts the VIEW. The switch notice lands LAST, so the
    // user reads the prior conversation with an inline "model changed" marker beneath it.
    const carried = reseated?.store.getSnapshot().state.transcript ?? [];
    expect(carried.map((e) => e.role)).toEqual(['user', 'assistant', 'notice']);
    expect(carried.some((e) => e.text.includes('sonnet reply'))).toBe(true); // the OLD model's answer survived

    // The MARKER, through the real Home builder — the only place the Home's argument order is pinned. `toContain` on
    // the new model alone would pass a REVERSED marker just as happily.
    const marker = carried.at(-1)?.text ?? '';
    expect(marker).toContain('claude-sonnet-4-6 → claude-opus-4-8');
    expect(marker).toContain('@-attached file contents included'); // ADR-0059's bound disclosure clause
    // The effort sub-step's tier bound onto the reseated agent (ADR-0066) — surfaced in the footer via the store.
    expect(reseated?.store.getSnapshot().reasoningEffort).toBe('medium');
    expect(props.controller.getSnapshot().modelPicker).toBeUndefined(); // the picker closed
    expect(props.controller.getSnapshot().mode).toBe('chat'); // stayed in chat

    // ADR-0140 §3: `/agent` on the RESEATED session shows the pair it runs on now. The real reseat built a new session over the swapped
    // definition, and the sheet reads THAT one, not the definition the chat started on (sonnet, no effort tier).
    props.controller.handlePaste('/agent');
    props.controller.handleKey('', ENTER);
    const agentSheet = props.controller.getSnapshot().chatSheet;
    expect(agentSheet?.kind).toBe('agent');
    const shown = agentSheet?.kind === 'agent' ? agentSheet.view : undefined;
    expect(shown?.detail.model).toBe('claude-opus-4-8');
    expect(shown?.detail.provider).toBe('anthropic');
    expect(shown?.detail.reasoningEffort).toBe('medium');
    expect(shown?.builtIn, 'the reseat kept the built-in agent, and the sheet knows it').toBe(true);
    props.controller.handleKey('', { escape: true });
    expect(props.controller.getSnapshot().chatSheet).toBeUndefined();

    // The durable row's agent snapshot updates to the switched model after the reseated session ends.
    props.controller.handleKey('c', CTRL_C); // /cancel ⇒ back to Home (the reseated session's terminal writes 'ended')
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    const full = createSessionStore(client.db).loadFull(sessionId);
    expect(full?.session.agentSnapshot?.model).toBe('claude-opus-4-8');
    expect(full?.session.agentSnapshot?.reasoning_effort).toBe('medium'); // the effort tier persisted onto the snapshot
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant']); // the single carried exchange

    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it.each([
    [false, {}, false, false],
    [true, {}, false, false],
    ['closed-before', {}, false, false],
    ['closed-during', {}, false, false],
    ['error-during', {}, false, false],
    [true, { CI: '' }, true, false],
    [true, { CI: '' }, true, true],
    ['closed-before', { CI: '' }, true, false],
    ['closed-during', { CI: '' }, true, false],
    ['error-during', { CI: '' }, true, false],
    [true, { CONTINUOUS_INTEGRATION: 'true' }, true, false],
    [true, { CONTINUOUS_INTEGRATION: 'true' }, true, true],
    [true, { CI: '' }, true, false, 1],
    [true, { CI: '' }, true, false, 24],
  ] as const)(
    'the REAL Home reseat displays disclosure before sweeping (actual Ink: %s, env=%j, default mount=%s, no-alt=%s, resizeRows=%s)',
    async (mode, env, defaultMount, noAltScreen, resizeRows?: number) => {
      const actualInk = mode !== false;
      let captured: RootAppProps | undefined;
      let buildChecks = 0;
      let size = { cols: 100, rows: 30 };
      let fireResize: (() => void) | undefined;
      const input = new OwnedTtyInput();
      const stdout = new OwnedTtyOutput();
      const stderr = new OwnedTtyOutput();
      let instance: Instance | undefined;
      let finishRenderer: () => void = () => undefined;
      const syntheticExit = new Promise<void>((resolve) => {
        finishRenderer = resolve;
      });
      let firstNoticeRows: number | undefined;
      stdout.onFrame = (frame) => {
        if (frame.includes('external effect') && firstNoticeRows === undefined) {
          firstNoticeRows = client.sqlite.prepare('SELECT * FROM run_effects').all().length;
          if (mode === 'closed-during') stdout.destroy();
          if (mode === 'error-during') stdout.destroy(new Error('SECRET_OUTPUT_FAILURE'));
        }
      };
      const realInk = await vi.importActual<typeof import('ink')>('ink');
      inkRenderer.render.mockImplementation((node, options) => {
        if (!isValidElement<RootAppProps>(node)) throw new Error('expected RootApp');
        captured = node.props;
        instance = realInk.render(node, { ...options, stdin: input, stdout, stderr, debug: false });
        return instance;
      });
      const { deps } = makeDeps(
        (props) => {
          captured = props;
        },
        {
          io: { ...io, env },
          getSize: () => size,
          subscribeResize: (callback) => {
            fireResize = callback;
            return () => {
              fireResize = undefined;
            };
          },
          global: { ...global, noAltScreen },
          render: (props, options) => {
            captured = props;
            if (!actualInk) {
              props.onRendererReady?.(async (publish) => {
                await publish?.();
              });
              return {
                unmount: finishRenderer,
                waitUntilRenderFlush: () => Promise.resolve(),
                waitUntilExit: () => syntheticExit,
              };
            }
            instance = renderInk(createElement(RootApp, props), {
              ...options,
              stdin: input,
              stdout,
              stderr,
              debug: false,
              exitOnCtrlC: false,
              patchConsole: false,
              alternateScreen: false,
            });
            return instance;
          },
          providers: scriptedResolver([textTurn('first reply')]),
          buildResumedSession: async (options) => {
            const built = await buildResumedChatSession(options);
            if (resizeRows !== undefined && buildChecks === 0) {
              size = { cols: 100, rows: resizeRows };
              stdout.rows = resizeRows;
              fireResize?.();
            }
            if (mode === 'closed-before' && buildChecks === 0) stdout.destroy();
            expect(client.sqlite.prepare('SELECT * FROM run_effects').all()).toHaveLength(
              buildChecks === 0 || resizeRows === 1 ? 2 : 1,
            );
            buildChecks++;
            return built;
          },
        },
      );
      let rendererError: unknown;
      const { render: injectedMount, ...productionDeps } = deps;
      expect(injectedMount).toBeDefined();
      expect(
        shouldOpenHome({
          stdoutIsTty: deps.io.stdoutIsTty,
          stdinIsTty: deps.io.stdinIsTty,
          json: deps.global.json,
          env: deps.io.env,
        }),
      ).toBe(true);
      const running = driveHome(defaultMount ? productionDeps : deps);
      const settled = running.catch((error: unknown) => {
        rendererError = error;
      });
      try {
        await instance?.waitUntilRenderFlush();
        const props = captured;
        if (props === undefined) throw new Error('render was not invoked');
        type(props, 'first');
        props.controller.handleKey('', ENTER);
        await flush();
        if (resizeRows !== undefined)
          await vi.waitFor(
            () => expect(stdout.frames.some((frame) => frame.includes('first reply'))).toBe(true),
            { timeout: WAIT_MS },
          );
        const sessionId = props.controller.getSnapshot().session?.sessionId;
        if (sessionId === undefined) throw new Error('missing active session');
        const turn = createSessionStore(client.db).reserveEffectTurnKey(sessionId);
        let next = 0;
        const journal = createEffectJournalStore(client.db, {
          uuid: () => `home-effect-${String(++next)}`,
          now: () => 0,
        });
        for (const [slot, state] of [
          [0, 'committed'],
          [1, 'ambiguous'],
        ] as const) {
          const identity = {
            scope: `session:${encodeURIComponent(sessionId)}:${String(turn)}`,
            slot,
            toolId: 'run_command',
          };
          journal.prepare(
            identity,
            { kind: 'session', sessionId, turn },
            { providerAttempt: 1, toolCallId: `session-tool:${String(turn)}:${String(slot)}` },
            3,
            'digest',
          );
          journal.settle(identity, state, 'synthetic private result');
        }
        const pick = async (model: string) => {
          props.controller.handleKey('/', {});
          type(props, 'models');
          props.controller.handleKey('', ENTER);
          await flush();
          type(props, model);
          props.controller.handleKey('', ENTER);
          if (props.controller.getSnapshot().modelPicker?.phase === 'effort')
            props.controller.handleKey('', ENTER);
          if (typeof mode === 'string')
            await vi.waitFor(() => expect(rendererError).toBeInstanceOf(Error), {
              timeout: WAIT_MS,
            });
          else
            await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
              timeout: WAIT_MS,
            });
          await instance?.waitUntilRenderFlush();
        };
        await pick('claude-opus-4-8');
        if (typeof mode === 'string') {
          await settled;
          expect(client.sqlite.prepare('SELECT * FROM run_effects').all()).toHaveLength(2);
          expect(firstNoticeRows).toBe(mode === 'closed-before' ? undefined : 2);
          expect(String(rendererError)).toContain('terminal output closed');
          expect(String(rendererError)).not.toContain('SECRET_OUTPUT_FAILURE');
          expect(closeSpy).toHaveBeenCalledTimes(1);
          return;
        }
        if (resizeRows === 1) {
          // A flushed footer is not a displayed disclosure. Retain the committed evidence and keep exit usable.
          expect(firstNoticeRows).toBeUndefined();
          expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
            { state: 'committed' },
            { state: 'ambiguous' },
          ]);
          expect(
            props.controller
              .getSnapshot()
              .session?.store.getSnapshot()
              .state.transcript.some(
                (entry) =>
                  entry.role === 'notice' && entry.text.includes('audit evidence was retained'),
              ),
          ).toBe(true);
          size = { cols: 100, rows: 30 };
          stdout.rows = 30;
          fireResize?.();
          await instance?.waitUntilRenderFlush();
          expect(client.sqlite.prepare('SELECT * FROM run_effects').all()).toHaveLength(2);
        } else
          expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
            { state: 'ambiguous' },
          ]);
        const notices = () =>
          props.controller
            .getSnapshot()
            .session?.store.getSnapshot()
            .state.transcript.filter(
              (entry) => entry.role === 'notice' && entry.text.includes('external effect'),
            ) ?? [];
        if (actualInk) {
          if (resizeRows !== 1) expect(firstNoticeRows).toBe(2);
          expect(inkRenderer.render.mock.calls[0]?.[1]).toMatchObject({
            interactive: true,
            ...(defaultMount ? { alternateScreen: !noAltScreen } : {}),
          });
        }
        expect(notices()).toHaveLength(1);
        expect(notices()[0]?.text).toContain('landed in a turn that did not complete');
        const displayedNotices = () =>
          stdout.frames.filter((frame) => frame.includes('external effect')).length;
        const displayedReplies = () =>
          stdout.frames.filter((frame) => frame.includes('first reply')).length;
        if (actualInk && noAltScreen) {
          expect(displayedNotices()).toBe(1);
          expect(displayedReplies()).toBe(1);
        }
        await pick('claude-sonnet-4-6');
        expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
          { state: 'ambiguous' },
        ]);
        expect(buildChecks).toBe(2);
        // Inline scrollback already owns the previous notice; only the new store's notice is retained.
        expect(notices()).toHaveLength(noAltScreen ? 1 : 2);
        expect(notices().at(-1)?.text).toContain('ambiguous');
        if (resizeRows === 1)
          expect(notices().at(-1)?.text).toContain('landed in a turn that did not complete');
        else expect(notices().at(-1)?.text).not.toContain('landed in a turn that did not complete');
        if (actualInk && noAltScreen) {
          expect(displayedNotices()).toBe(2);
          expect(displayedReplies()).toBe(1); // reseat never reprints the earlier exchange
        }
        props.controller.handleKey('c', CTRL_C);
        props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
        await flush();
        props.controller.handleKey('c', CTRL_C);
        props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
        expect(await running).toBe(0);
      } finally {
        instance?.unmount();
        finishRenderer();
        if (captured !== undefined) await captured.controller.teardownActive();
        await settled;
        instance?.cleanup();
        await vi.waitFor(
          () => {
            expect(stdout.listenerCount('close')).toBe(0);
            expect(stdout.listenerCount('error')).toBe(0);
          },
          { timeout: WAIT_MS },
        );
        input.destroy();
        stdout.destroy();
        stderr.destroy();
      }
    },
  );

  it('a reseat notice fired DURING the build is buffered and flushed into the transcript, not lost to stderr (review M5/bot)', async () => {
    // The store is seeded from the build (it needs `built.resumeState`), so it cannot exist yet when a governor/
    // effort callback fires mid-build. The old sink wrote such a notice to stderr, which the alt-screen renderer's
    // next frame erases — and `onceEffortNotice` had already marked it delivered, so it never repeated: silently
    // lost. Buffer + flush is the fix. Drive the REAL reseatChat, firing an `onUnpriced` note DURING the build.
    const errs: string[] = [];
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      io: { ...io, writeErr: (t: string) => errs.push(t) },
      providers: scriptedResolver([textTurn('sonnet reply'), textTurn('opus reply')]),
      // Fire a notice WHILE the resumed session builds (before the store exists), then delegate to the real builder.
      buildResumedSession: (args) => {
        args.onUnpriced?.('UNPRICED-MID-BUILD');
        return buildResumedChatSession(args);
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    type(props, 'first');
    props.controller.handleKey('', ENTER);
    await flush();
    const sessionId = props.controller.getSnapshot().session?.sessionId ?? '';
    expect(sessionId).not.toBe('');

    props.controller.handleKey('/', {});
    type(props, 'models');
    props.controller.handleKey('', ENTER);
    await flush();
    type(props, 'claude-opus-4-8');
    props.controller.handleKey('', ENTER); // reasoning-capable ⇒ effort sub-step
    props.controller.handleKey('', ENTER); // apply the default tier ⇒ the REAL reseatChat (fires the mid-build note)
    await flush();

    const transcript =
      props.controller.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
    // THE FIX: the mid-build note reached the TRANSCRIPT (a `notice` entry), not erased stderr.
    expect(
      transcript.some((e) => e.role === 'notice' && e.text.includes('UNPRICED-MID-BUILD')),
    ).toBe(true);
    expect(errs.join('')).not.toContain('UNPRICED-MID-BUILD'); // …and it was NOT written to stderr

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('a KEY-LESS first run runs the onboarding wizard BEFORE mounting the Home (2.5.G S8)', async () => {
    // A scripted clack slice + a key-less resolver (keyFor throws for every provider) ⇒ the wizard triggers.
    const outros: string[] = [];
    const select = vi.fn(() => Promise.resolve('anthropic'));
    const onboardingPrompter: ClackOnboardingDeps = {
      intro: () => undefined,
      outro: (m) => outros.push(m),
      note: () => undefined,
      select,
      password: () => Promise.resolve('sk-home-9999'),
      isCancel: (v): v is symbol => typeof v === 'symbol',
    };
    const keylessResolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => {
        throw new Error('no key');
      },
    };
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      providers: keylessResolver,
      onboardingPrompter,
      // An ISOLATED config file in the per-test cwd — the wizard's success path writes the chosen provider's starter
      // model here (via writeGlobalDefaultModel), so it must not touch the shared tmp configPath other tests use.
      global: { ...global, configPath: join(cwd, 'wizard-config.toml') },
    });
    const drivePromise = driveHome(deps);
    await flush(); // the wizard is async — let it settle before render() mounts ink
    const props = captured;
    if (props === undefined) throw new Error('the Home did not mount after the wizard');
    expect(select).toHaveBeenCalledTimes(1); // the wizard ran (provider select)
    // The wizard reached its success path + handed off to the Home. (Real keychain STORAGE is proven in
    // wizard.test.ts with an inspectable keychain; here the module-level vi.mock discards the key, which is what
    // keeps the test off the developer's/CI's real OS keychain.)
    expect(outros.some((o) => o.includes('all set'))).toBe(true);

    props.controller.handleKey('c', CTRL_C); // clean exit
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('registers the exit-safety nets BEFORE a key-less onboarding prompt can await the network (G0, #50)', async () => {
    // Hold the first clack prompt open. The old ordering subscribed only AFTER the wizard settled, so a Ctrl-C or
    // Ctrl-Z during the wizard's later key-validation request had no Home-owned safety net at all. Capture the
    // ordering before settling the prompt, then complete the normal clean-exit path so this regression test leaves
    // no open db handle or pending Home promise behind.
    const order: string[] = [];
    let resolveSelect: ((value: string | symbol) => void) | undefined;
    const select = new Promise<string | symbol>((resolve) => {
      resolveSelect = resolve;
    });
    const onboardingPrompter: ClackOnboardingDeps = {
      ...CANCEL_ONBOARDING,
      select: () => {
        order.push('wizard-select');
        return select;
      },
    };
    const keylessResolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => {
        throw new Error('no key');
      },
    };
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((props) => (captured = props), {
      providers: keylessResolver,
      onboardingPrompter,
      subscribeSignals: () => {
        order.push('signals');
        return () => undefined;
      },
      subscribeProcessExit: () => {
        order.push('exit-net');
        return () => undefined;
      },
      jobControlLifecycle: {
        supported: true,
        onSuspend: () => {
          order.push('job-suspend');
          return () => undefined;
        },
        onContinue: () => {
          order.push('job-continue');
          return () => undefined;
        },
        suspendSelf: () => undefined,
      },
    });

    const drivePromise = driveHome(deps);
    await flush();
    const beforeWizardSettles = [...order];

    if (resolveSelect === undefined) throw new Error('the onboarding select did not start');
    resolveSelect(Symbol('cancel'));
    await flush();
    const props = captured;
    if (props === undefined) throw new Error('the Home did not mount after onboarding');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);

    expect(beforeWizardSettles).toEqual([
      'signals',
      'exit-net',
      'job-continue',
      'job-suspend',
      'wizard-select',
    ]);
  });

  it('hands Clack raw input + cursor back around BOTH raw Ctrl-Z and external SIGTSTP during onboarding (G0)', async () => {
    // Hold Clack's first raw-mode prompt open. Unlike the earlier order-only regression, this models the terminal
    // custody that exists before Ink mounts: Ctrl-Z is a SUB byte here, and an external SIGTSTP has no SuspendPort.
    let resolveSelect: ((value: string | symbol) => void) | undefined;
    const select = new Promise<string | symbol>((resolve) => {
      resolveSelect = resolve;
    });
    const onboardingPrompter: ClackOnboardingDeps = {
      ...CANCEL_ONBOARDING,
      select: () => select,
    };
    const keylessResolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => {
        throw new Error('no key');
      },
    };
    const terminalEvents: string[] = [];
    let clackOwnsRawMode = true;
    let rawInput: ((input: string) => void) | undefined;
    let suspend: (() => void) | undefined;
    let activeSuspend: (() => void) | undefined;
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((props) => (captured = props), {
      providers: keylessResolver,
      onboardingPrompter,
      writeControl: (sequence) => terminalEvents.push(`control:${sequence}`),
      onboardingTerminalLifecycle: {
        onInput: (listener) => {
          rawInput = listener;
          return () => {
            rawInput = undefined;
          };
        },
        isRawMode: () => clackOwnsRawMode,
        setRawMode: (enabled) => {
          clackOwnsRawMode = enabled;
          terminalEvents.push(`raw:${String(enabled)}`);
        },
      },
      jobControlLifecycle: {
        supported: true,
        onSuspend: (listener) => {
          activeSuspend = listener;
          suspend = listener;
          return () => {
            if (activeSuspend === listener) activeSuspend = undefined;
          };
        },
        onContinue: () => () => undefined,
        // In production this returns only after `fg`/SIGCONT. The synchronous fake therefore observes the exact
        // release → stop → reclaim order without suspending Vitest itself.
        suspendSelf: () => terminalEvents.push('self-stop'),
      },
    });

    const drivePromise = driveHome(deps);
    await flush();
    if (rawInput === undefined || suspend === undefined)
      throw new Error('onboarding did not install its raw-input/job-control handoff');

    rawInput('\x1a');
    expect(terminalEvents).toEqual([
      'raw:false',
      `control:${SHOW_CURSOR}`,
      'self-stop',
      'raw:true',
      `control:${HIDE_CURSOR}`,
    ]);

    terminalEvents.length = 0;
    activeSuspend?.(); // the external `kill -TSTP` path uses the SAME no-Ink custody pair
    expect(terminalEvents).toEqual([
      'raw:false',
      `control:${SHOW_CURSOR}`,
      'self-stop',
      'raw:true',
      `control:${HIDE_CURSOR}`,
    ]);

    // After Clack closes its spinner/prompt it has returned cooked input + a visible cursor. The wizard may still be
    // awaiting keychain/config work, but that interval owns no terminal modes and must not synthesize raw+hidden
    // state merely because a SIGTSTP arrives.
    terminalEvents.length = 0;
    clackOwnsRawMode = false;
    activeSuspend?.();
    expect(terminalEvents).toEqual(['self-stop']);

    if (resolveSelect === undefined) throw new Error('the onboarding select did not start');
    resolveSelect(Symbol('cancel'));
    await flush();
    const props = captured;
    if (props === undefined) throw new Error('the Home did not mount after onboarding');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('reclaims Clack cursor ownership when the release write faults after raw mode is handed off (G0)', async () => {
    // stdout can fail after the terminal accepts part of an escape sequence. In particular, a failed SHOW_CURSOR
    // must be treated as a possible visible cursor: rolling raw mode back alone would return Clack to a live prompt
    // with its cursor exposed.
    let resolveSelect: ((value: string | symbol) => void) | undefined;
    const select = new Promise<string | symbol>((resolve) => {
      resolveSelect = resolve;
    });
    const keylessResolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => {
        throw new Error('no key');
      },
    };
    const terminalEvents: string[] = [];
    let clackOwnsRawMode = true;
    let rawInput: ((input: string) => void) | undefined;
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((props) => (captured = props), {
      providers: keylessResolver,
      onboardingPrompter: { ...CANCEL_ONBOARDING, select: () => select },
      writeControl: (sequence) => {
        terminalEvents.push(`control:${sequence}`);
        if (sequence === SHOW_CURSOR) throw new Error('partial cursor write');
      },
      onboardingTerminalLifecycle: {
        onInput: (listener) => {
          rawInput = listener;
          return () => {
            rawInput = undefined;
          };
        },
        isRawMode: () => clackOwnsRawMode,
        setRawMode: (enabled) => {
          clackOwnsRawMode = enabled;
          terminalEvents.push(`raw:${String(enabled)}`);
        },
      },
      jobControlLifecycle: {
        supported: true,
        onSuspend: () => () => undefined,
        onContinue: () => () => undefined,
        // A failed terminal release must never forward SIGTSTP: there is no safe stopped state to return from.
        suspendSelf: () => terminalEvents.push('self-stop'),
      },
    });

    const drivePromise = driveHome(deps);
    await flush();
    if (rawInput === undefined) throw new Error('onboarding did not install its raw-input handoff');

    rawInput('\x1a');
    expect(terminalEvents).toEqual([
      'raw:false',
      `control:${SHOW_CURSOR}`,
      'raw:true',
      `control:${HIDE_CURSOR}`,
    ]);
    expect(clackOwnsRawMode).toBe(true);

    if (resolveSelect === undefined) throw new Error('the onboarding select did not start');
    resolveSelect(Symbol('cancel'));
    await flush();
    const props = captured;
    if (props === undefined) throw new Error('the Home did not mount after onboarding');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('retries a failed Clack cursor reclaim before a later stop request (G0)', async () => {
    let resolveSelect: ((value: string | symbol) => void) | undefined;
    const select = new Promise<string | symbol>((resolve) => {
      resolveSelect = resolve;
    });
    const keylessResolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => {
        throw new Error('no key');
      },
    };
    const terminalEvents: string[] = [];
    let clackOwnsRawMode = true;
    let rawInput: ((input: string) => void) | undefined;
    let captured: RootAppProps | undefined;
    let failShowOnce = true;
    let failHideOnce = true;
    const { deps } = makeDeps((props) => (captured = props), {
      providers: keylessResolver,
      onboardingPrompter: { ...CANCEL_ONBOARDING, select: () => select },
      writeControl: (sequence) => {
        terminalEvents.push(`control:${sequence}`);
        if (sequence === SHOW_CURSOR && failShowOnce) {
          failShowOnce = false;
          throw new Error('partial cursor release');
        }
        if (sequence === HIDE_CURSOR && failHideOnce) {
          failHideOnce = false;
          throw new Error('partial cursor reclaim');
        }
      },
      onboardingTerminalLifecycle: {
        onInput: (listener) => {
          rawInput = listener;
          return () => {
            rawInput = undefined;
          };
        },
        isRawMode: () => clackOwnsRawMode,
        setRawMode: (enabled) => {
          clackOwnsRawMode = enabled;
          terminalEvents.push(`raw:${String(enabled)}`);
        },
      },
      jobControlLifecycle: {
        supported: true,
        onSuspend: () => () => undefined,
        onContinue: () => () => undefined,
        suspendSelf: () => terminalEvents.push('self-stop'),
      },
    });

    const drivePromise = driveHome(deps);
    await flush();
    if (rawInput === undefined) throw new Error('onboarding did not install its raw-input handoff');

    rawInput('\x1a');
    expect(terminalEvents).toEqual([
      'raw:false',
      `control:${SHOW_CURSOR}`,
      'raw:true',
      `control:${HIDE_CURSOR}`,
    ]);

    // The second request must first retry the cursor reclaim left latched above, then safely release/stop/reclaim.
    rawInput('\x1a');
    expect(terminalEvents).toEqual([
      'raw:false',
      `control:${SHOW_CURSOR}`,
      'raw:true',
      `control:${HIDE_CURSOR}`,
      `control:${HIDE_CURSOR}`,
      'raw:false',
      `control:${SHOW_CURSOR}`,
      'self-stop',
      'raw:true',
      `control:${HIDE_CURSOR}`,
    ]);
    expect(clackOwnsRawMode).toBe(true);

    if (resolveSelect === undefined) throw new Error('the onboarding select did not start');
    resolveSelect(Symbol('cancel'));
    await flush();
    const props = captured;
    if (props === undefined) throw new Error('the Home did not mount after onboarding');
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('SIGTSTP/SIGCONT never take the Home termination path (G0)', async () => {
    let onSuspend: () => void = () => undefined;
    let onContinue: () => void = () => undefined;
    const suspendSelf = vi.fn();
    const exit = vi.fn();
    let captured: RootAppProps | undefined;
    const { deps, unmount, writeControl } = makeDeps((props) => (captured = props), {
      exit: exit as (code: number) => void,
      jobControlLifecycle: {
        supported: true,
        onSuspend: (listener) => {
          onSuspend = listener;
          return () => undefined;
        },
        onContinue: (listener) => {
          onContinue = listener;
          return () => undefined;
        },
        suspendSelf,
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the Home did not mount');

    onContinue(); // unexpected continuation: a no-op, not a teardown
    onSuspend();
    expect(suspendSelf).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(unmount).not.toHaveBeenCalled();
    expect(writeControl).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('disarms a pending job-control continuation BEFORE TERM restores the Home terminal (G0)', async () => {
    // Regression for the adversarial order TERM/HUP/QUIT → SIGCONT: permanent teardown owns the final terminal
    // state, so an old reversible waiter must never subsequently emit ENABLE_MOUSE behind its one-shot restore latch.
    let onSuspend: (() => void) | undefined;
    let onContinue: (() => void) | undefined;
    let captured: RootAppProps | undefined;
    const exit = vi.fn();
    const { deps, signalHandlers, writeControl } = makeDeps((props) => (captured = props), {
      exit: exit as (code: number) => void,
      jobControlLifecycle: {
        supported: true,
        onSuspend: (listener) => {
          onSuspend = listener;
          return () => {
            if (onSuspend === listener) onSuspend = undefined;
          };
        },
        onContinue: (listener) => {
          onContinue = listener;
          return () => {
            if (onContinue === listener) onContinue = undefined;
          };
        },
        suspendSelf: () => undefined,
      },
    });
    void driveHome(deps); // a real TERM calls process.exit; the injected exit intentionally keeps this harness alive
    const props = captured;
    if (props?.suspendPort === undefined)
      throw new Error('the Home did not expose its suspend port');
    props.setMouseCapture?.(true);
    props.suspendPort.attach(async (callback) => callback());

    onSuspend?.();
    await flush();
    expect(writeControl).toHaveBeenCalledWith(DISABLE_MOUSE); // mounted Ink suspension released our live mouse mode
    const writesBeforeTerminalTeardown = writeControl.mock.calls.length;

    signalHandlers[0]?.(15); // permanent teardown first disposes the reversible continuation listener
    onContinue?.(); // removed listener: cannot trigger `suspendFullScreen`'s ENABLE_MOUSE reclaim
    await flush();

    const controlsAfterTerminalTeardown = writeControl.mock.calls
      .slice(writesBeforeTerminalTeardown)
      .map((call) => String(call[0]));
    expect(controlsAfterTerminalTeardown).not.toContain(ENABLE_MOUSE);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('a run WITH a resolvable key SKIPS the onboarding wizard entirely', async () => {
    // The default scriptedResolver's keyFor returns 'test-key' ⇒ not key-less ⇒ the wizard must never run.
    const select = vi.fn(() => Promise.resolve('anthropic'));
    const onboardingPrompter: ClackOnboardingDeps = {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      select,
      password: () => Promise.resolve('sk-x'),
      isCancel: (v): v is symbol => typeof v === 'symbol',
    };
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), { onboardingPrompter });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('render was not invoked');
    expect(select).not.toHaveBeenCalled(); // no wizard on a keyed run

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('an external SIGINT tears the live chat down and exits 130 (128+SIGINT)', async () => {
    let captured: RootAppProps | undefined;
    let signal: ((signo: number) => void) | undefined;
    const exitSpy = vi.fn();
    const { deps, unmount, writeControl } = makeDeps((p) => (captured = p), {
      subscribeSignals: (onSignal) => {
        signal = onSignal;
        return () => undefined;
      },
      exit: exitSpy,
    });
    void driveHome(deps); // never resolves on the signal path — hold it, assert the side effects
    const props = captured;
    if (props === undefined || signal === undefined) throw new Error('render/signal not wired');

    type(props, 'hi');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(props.controller.getSnapshot().mode).toBe('chat');

    signal(2); // an external SIGINT
    await flush();

    expect(unmount).toHaveBeenCalledTimes(1); // terminal restored first
    const controls = writeControl.mock.calls.map((c) => c[0] as string);
    expect(controls).toContain(DISABLE_BRACKETED_PASTE); // paste + mouse restored on the signal teardown
    expect(controls).toContain(DISABLE_MOUSE);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(createSessionStore(client.db).listSessions({ limit: 10 })[0]?.status).toBe('ended');
  });

  it('an external SIGTERM exits 143 (128+SIGTERM)', async () => {
    let signal: ((signo: number) => void) | undefined;
    const exitSpy = vi.fn();
    const { deps } = makeDeps(() => undefined, {
      subscribeSignals: (onSignal) => {
        signal = onSignal;
        return () => undefined;
      },
      exit: exitSpy,
    });
    void driveHome(deps);
    if (signal === undefined) throw new Error('signal not wired');

    signal(15); // SIGTERM with no live chat
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(143);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('a second signal force-exits immediately; the db is still closed only once', async () => {
    let signal: ((signo: number) => void) | undefined;
    const exitSpy = vi.fn();
    const { deps } = makeDeps(() => undefined, {
      subscribeSignals: (onSignal) => {
        signal = onSignal;
        return () => undefined;
      },
      exit: exitSpy,
    });
    void driveHome(deps);
    if (signal === undefined) throw new Error('signal not wired');

    signal(2); // first: starts the bounded teardown race
    signal(2); // second while the race is still pending: the `signaled` latch force-exits immediately
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(exitSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // the force-exit + the race-settled exit
    expect(closeSpy).toHaveBeenCalledTimes(1); // closeDb is idempotent across both signals
  });

  it('builds a KEYCHAIN-backed key resolver when `providers` is not injected (regression: provider_auth)', async () => {
    resolverKeychainArg.value = 'unset';
    // OMIT the injected `providers` (rest-destructure) → the composition-root default path runs, which MUST pass the
    // OS keychain to the resolver (else a keychain-stored key is invisible and the first Home-chat turn fails
    // `provider_auth`).
    const { deps: injected } = makeDeps(() => undefined, {
      subscribeSignals: () => () => undefined,
      exit: () => undefined,
    });
    const deps: HomeDeps = { ...injected };
    delete (deps as { providers?: unknown }).providers; // exercise the default (keychain) resolver path
    void driveHome(deps); // the provider wiring runs synchronously before the ink mount
    await flush();
    expect(resolverKeychainArg.value).toBe(keychainSentinel); // the resolver received the keychain, not env-only
  });

  /**
   * The terminal-restore NETS (2.6.F Step 6f, Opus review). Mouse reporting is a mode we set on the USER'S terminal,
   * and every path out of the process must clear it — otherwise the shell they return to echoes an SGR report on every
   * click and drag. `relavium chat` has covered SIGTERM/SIGHUP/SIGQUIT plus a `process.on('exit')` net since Step
   * 4b-3; the bare Home listened only for SIGINT and SIGTERM, so closing the terminal window (SIGHUP) stranded
   * DECSET 1002+1006.
   *
   * These tests never await `driveHome`: on a signal it hands off to `process.exit`, which the injected `exit` mock
   * does not perform, so the drive promise stays pending by design. The restore is SYNCHRONOUS — that is the point —
   * so every assertion below reads `writeControl` the moment the handler returns.
   */
  /**
   * `[preferences].copy_on_select` (2.6.F Step 6e). The switch reaches the ink tree as the PRESENCE of the `clipboard`
   * prop: absent ⇒ a released drag still highlights and never touches the system clipboard. `/copy` binds its own
   * clipboard through the hatch ports, so it keeps working either way.
   */
  /**
   * THE CAPS-LIFT, END TO END (2.6.F Step 6g). `session-view-model.test.ts` pins the reducer; a break that makes
   * `transcriptBoundFor` always return the inline bound stays GREEN there, because the unit tests inject the bound
   * themselves. This drives the REAL `startChat` and asserts what the user's viewport would actually hold.
   */
  describe('a long assistant answer survives into the full-screen transcript', () => {
    const LONG = 'X'.repeat(10_000);

    const assistantText = async (over: Partial<HomeDeps>): Promise<string> => {
      let captured: RootAppProps | undefined;
      const { deps } = makeDeps((p) => (captured = p), {
        providers: scriptedResolver([textTurn(LONG)]),
        ...over,
      });
      const drivePromise = driveHome(deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');

      type(props, 'hello');
      props.controller.handleKey('', ENTER); // submit ⇒ build + first turn
      await flush();
      await flush();
      const transcript =
        props.controller.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
      const assistant = transcript.find((e) => e.role === 'assistant');

      props.controller.handleKey('c', CTRL_C); // chat Ctrl-C ⇒ /cancel ⇒ back to Home
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await flush();
      props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await drivePromise;
      return assistant?.text ?? '';
    };

    it('the alt-screen Home keeps all 10 000 characters', async () => {
      expect(await assistantText({})).toHaveLength(10_000);
    });

    it('`--no-alt-screen` keeps the historical trailing tail — the inline renderer has no viewport', async () => {
      const text = await assistantText({ global: { ...global, noAltScreen: true } });
      expect(text).toHaveLength(4001);
      expect(text.startsWith('…')).toBe(true);
    });
  });

  /**
   * BUDGET WARNINGS GO INTO THE TRANSCRIPT, NEVER RAW STDERR (2.6.F Step 6g, whole-phase Opus review).
   * `relavium chat` learned this in the Step-4b-3 Sonnet fold: on the alt screen a raw `writeErr` is painted over by
   * ink's next frame, so the user is told they are near their spending cap on a line that lives for one frame.
   * `driveHome` was still writing raw.
   */
  it('wires interrupted-effect disclosure to the production Home transcript', async () => {
    let captured: RootAppProps | undefined;
    let built: Awaited<ReturnType<typeof buildChatSession>> | undefined;
    let executions = 0;
    const errs: string[] = [];
    const made = makeDeps(
      (props) => {
        captured = props;
      },
      {
        io: { ...io, writeErr: (text) => errs.push(text) },
        providers: scriptedResolver([
          textTurn('ready'),
          [
            { type: 'tool_call_start', id: 'write', name: 'write_file' },
            {
              type: 'tool_call_delta',
              id: 'write',
              argsJsonDelta: JSON.stringify({ path: 'private-target', content: 'new' }),
            },
            { type: 'tool_call_end', id: 'write' },
            stop('tool_use'),
          ],
        ]),
        buildSession: async (options) => {
          expect(options.onEffectAttention).toBeTypeOf('function');
          built = await buildChatSession({
            ...options,
            toolHost: {
              fs: {
                readFile: () =>
                  Promise.resolve({
                    content: '',
                    mimeType: 'text/plain',
                    sizeBytes: 0,
                    lastModified: '',
                  }),
                listDirectory: () => Promise.resolve({ entries: [] }),
                writeFile: () => Promise.reject(new Error('blind write forbidden')),
                prepareWrite: () =>
                  Promise.resolve({
                    path: 'private-target',
                    before: 'old',
                    after: 'new',
                    release: () => {},
                    execute: () => {
                      executions++;
                      built?.session.abort();
                      return Promise.resolve({ path: 'private-target', bytesWritten: 3 });
                    },
                  }),
              },
            },
          });
          return built;
        },
      },
    );
    const driving = driveHome(made.deps);
    const props = captured;
    if (props === undefined) throw new Error('Home render was not invoked');
    type(props, 'hello');
    props.controller.handleKey('', ENTER);
    await flush();
    await flush();
    if (built === undefined || built.startingMode === undefined)
      throw new Error('missing Home host');
    applyChatMode(
      makeChatModeEnv({
        session: built.session,
        tools: built.tools,
        workspaceDir: built.context.workingDir,
        startingModeAuthority: built.startingMode.authority,
        prompt: () => Promise.resolve({ outcome: 'approve', scope: 'once' }),
      }),
      'accept-edits',
    );
    type(props, 'write');
    props.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(executions).toBe(1), { timeout: WAIT_MS });
    await built?.whenHostSafeToClose();
    const transcript =
      props.controller.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
    expect(
      transcript.some(
        (entry) => entry.role === 'notice' && entry.text === ABORTED_EFFECT_ATTENTION_NOTICE,
      ),
    ).toBe(true);
    expect(errs.join('')).not.toContain(ABORTED_EFFECT_ATTENTION_NOTICE);
    expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
      expect.objectContaining({ state: 'prepared' }),
    ]);
    expect(
      JSON.stringify(client.sqlite.prepare('SELECT content FROM session_messages').all()),
    ).not.toContain(ABORTED_EFFECT_ATTENTION_NOTICE);
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await flush();
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
    await driving;
  });

  it.each([
    { surface: 'fresh', delivery: 'immediate', liveAbort: false },
    { surface: 'resumed', delivery: 'immediate', liveAbort: false },
    { surface: 'cleared', delivery: 'immediate', liveAbort: false },
    { surface: 'reseated', delivery: 'immediate', liveAbort: false },
    { surface: 'fresh', delivery: 'held', liveAbort: false },
    { surface: 'fresh', delivery: 'failed', liveAbort: false },
    { surface: 'fresh', delivery: 'immediate', liveAbort: true },
  ] as const)(
    'delivers joined uncertainty after owned $surface Home unmount (delivery=$delivery; liveAbort=$liveAbort)',
    async ({ surface, delivery, liveAbort }) => {
      const f = invocationFixture();
      let captured: RootAppProps | undefined;
      let built: Awaited<ReturnType<typeof buildChatSession>> | undefined;
      let executions = 0;
      let released = false;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = () => {
          released = true;
          resolve();
        };
      });
      const errs: string[] = [],
        order: string[] = [];
      let acknowledge = () => {};
      let deliveryEntered = false;
      const deliveryAck =
        delivery === 'held'
          ? new Promise<void>((resolve) => {
              acknowledge = resolve;
            })
          : Promise.resolve();
      const toolHost: NonNullable<Parameters<typeof buildChatSession>[0]['toolHost']> = {
        fs: {
          readFile: () =>
            Promise.resolve({
              content: '',
              mimeType: 'text/plain',
              sizeBytes: 0,
              lastModified: '',
            }),
          listDirectory: () => Promise.resolve({ entries: [] }),
          writeFile: () => Promise.reject(new Error('blind write forbidden')),
          prepareWrite: () =>
            Promise.resolve({
              path: 'private-target',
              before: 'old',
              after: 'new',
              release: () => {},
              execute: async () => {
                executions++;
                await held;
                return { path: 'private-target', bytesWritten: 3 };
              },
            }),
        },
      };
      const made = makeDeps(
        (props) => {
          captured = props;
        },
        {
          invocation: f.invocation,
          io: {
            ...io,
            writeErr: (text) => {
              errs.push(text);
              order.push('stderr-sync');
            },
            writeErrAcknowledged: async (text) => {
              expect(order).toContain('restored');
              deliveryEntered = true;
              await deliveryAck;
              if (delivery === 'failed') throw new Error('private-attention-output-failure');
              errs.push(text);
              order.push('stderr-ack');
            },
            writeOutAcknowledged: (text) => {
              if (text === DISABLE_BRACKETED_PASTE + DISABLE_MOUSE + SHOW_CURSOR)
                order.push('restored');
              return Promise.resolve();
            },
          },
          providers: scriptedResolver([
            textTurn('ready'),
            [
              { type: 'tool_call_start', id: 'write', name: 'write_file' },
              {
                type: 'tool_call_delta',
                id: 'write',
                argsJsonDelta: JSON.stringify({ path: 'private-target', content: 'new' }),
              },
              { type: 'tool_call_end', id: 'write' },
              stop('tool_use'),
            ],
          ]),
          buildSession: async (options) => {
            built = await buildChatSession({ ...options, toolHost });
            return built;
          },
          buildResumedSession: async (options) => {
            const resumed = await buildResumedChatSession({ ...options, toolHost });
            built = resumed;
            return resumed;
          },
        },
      );
      const driving = driveHome(made.deps);
      const completion = driving.then(
        (value) => ({ value }),
        (cause: unknown) => ({ cause }),
      );
      try {
        const props = captured;
        if (props === undefined) throw new Error('Home render missing');
        type(props, 'hello');
        props.controller.handleKey('', ENTER);
        await vi.waitFor(
          () => {
            expect(props.controller.getSnapshot().mode).toBe('chat');
            expect(props.controller.getSnapshot().submitBusy).toBe(false);
          },
          { timeout: WAIT_MS },
        );
        const first = props.controller.getSnapshot().session;
        if (surface === 'resumed') {
          type(props, '/cancel');
          props.controller.handleKey('', ENTER);
          await vi.waitFor(() => expect(props.controller.getSnapshot().mode).toBe('home'), {
            timeout: WAIT_MS,
          });
          props.controller.handleKey('', { downArrow: true });
          props.controller.handleKey('', ENTER);
          await vi.waitFor(
            () => {
              expect(props.controller.getSnapshot().mode).toBe('chat');
              expect(props.controller.getSnapshot().session).not.toBe(first);
            },
            { timeout: WAIT_MS },
          );
        } else if (surface === 'cleared') {
          type(props, '/clear');
          props.controller.handleKey('', ENTER);
          await vi.waitFor(
            () => {
              expect(props.controller.getSnapshot().session).not.toBe(first);
              expect(props.controller.getSnapshot().mode).toBe('chat');
            },
            { timeout: WAIT_MS },
          );
        } else if (surface === 'reseated') {
          type(props, '/models');
          props.controller.handleKey('', ENTER);
          await vi.waitFor(() => expect(props.controller.getSnapshot().modelPicker).toBeDefined(), {
            timeout: WAIT_MS,
          });
          type(props, 'claude-opus-4-8');
          props.controller.handleKey('', ENTER);
          if (props.controller.getSnapshot().modelPicker?.phase === 'effort')
            props.controller.handleKey('', ENTER);
          await vi.waitFor(() => expect(props.controller.getSnapshot().session).not.toBe(first), {
            timeout: WAIT_MS,
          });
        }
        if (built === undefined || built.startingMode === undefined)
          throw new Error('Home host missing');
        await vi.waitFor(() => expect(props.controller.getSnapshot().submitBusy).toBe(false), {
          timeout: WAIT_MS,
        });
        applyChatMode(
          makeChatModeEnv({
            session: built.session,
            tools: built.tools,
            workspaceDir: built.context.workingDir,
            startingModeAuthority: built.startingMode.authority,
            prompt: () => Promise.resolve({ outcome: 'approve', scope: 'once' }),
          }),
          'accept-edits',
        );
        type(props, 'write');
        props.controller.handleKey('', ENTER);
        await vi.waitFor(() => expect(executions).toBe(1), { timeout: WAIT_MS });
        const originatingStore = props.controller.getSnapshot().session?.store;
        if (liveAbort) {
          built.session.abort();
          release();
          await built.whenHostSafeToClose();
          await vi.waitFor(
            () =>
              expect(
                originatingStore
                  ?.getSnapshot()
                  .state.transcript.some((entry) => entry.text === ABORTED_EFFECT_ATTENTION_NOTICE),
              ).toBe(true),
            { timeout: WAIT_MS },
          );
        }
        made.signalHandlers[0]?.(15);
        await vi.waitFor(() => expect(made.unmount).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
        expect(released).toBe(liveAbort);
        if (!liveAbort) {
          expect(errs.join('')).not.toContain(ABORTED_EFFECT_ATTENTION_NOTICE);
          expect(f.exit).not.toHaveBeenCalled();
        }
        release();
        await built.whenHostSafeToClose();
        if (delivery === 'held') {
          await vi.waitFor(() => expect(deliveryEntered).toBe(true), { timeout: WAIT_MS });
          expect(order).toContain('restored');
          expect(f.exit).not.toHaveBeenCalled();
          expect(closeSpy).not.toHaveBeenCalled();
          acknowledge();
        }
        const outcome = await completion;
        if (delivery === 'failed') {
          expect('cause' in outcome).toBe(true);
          expect(f.registry.observations.infrastructureCode()).toBe('output_unavailable');
        } else {
          expect('value' in outcome).toBe(true);
          expect(errs).toContain(ABORTED_EFFECT_ATTENTION_NOTICE + '\n');
          expect(order.indexOf('stderr-ack')).toBeGreaterThan(order.indexOf('restored'));
        }
        expect(order).not.toContain('stderr-sync');
        expect(
          originatingStore
            ?.getSnapshot()
            .state.transcript.some((entry) => entry.text === ABORTED_EFFECT_ATTENTION_NOTICE),
        ).toBe(liveAbort);
        expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
          expect.objectContaining({ state: 'prepared' }),
        ]);
        expect(
          JSON.stringify(client.sqlite.prepare('SELECT content FROM session_messages').all()),
        ).not.toContain(ABORTED_EFFECT_ATTENTION_NOTICE);
        expect(errs.join('')).not.toContain('private-target');
        expect(errs.join('')).not.toContain('private-attention-output-failure');
        if (delivery === 'failed') {
          expect(f.registry.activeOwners).toBe(0);
          expect(f.exit).not.toHaveBeenCalled();
          // Infrastructure failure reserves the existing diagnostic interval before its finite backstop.
          f.advance(3_000);
        }
        await vi.waitFor(
          () => expect(f.exit).toHaveBeenCalledWith(delivery === 'failed' ? 9 : 143),
          { timeout: WAIT_MS },
        );
      } finally {
        release();
        acknowledge();
        made.signalHandlers[0]?.(15);
        await completion;
        await f.registry.terminate({ kind: 'normal' });
      }
    },
  );

  describe('a budget warning reaches the in-Home chat’s transcript', () => {
    it('routes through the view store, and never to stderr', async () => {
      let captured: RootAppProps | undefined;
      let warn: ((w: { thresholdPct: number; limitMicrocents: number }) => void) | undefined;
      const errs: string[] = [];
      const made = makeDeps((p) => (captured = p), {
        io: { ...io, writeErr: (t: string) => errs.push(t) },
        buildSession: (async (opts: { onBudgetWarning?: typeof warn }) => {
          warn = opts.onBudgetWarning;
          return (await buildChatSession(opts as never)) as never;
        }) as never,
      });
      const drivePromise = driveHome(made.deps);
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');

      type(props, 'hello');
      props.controller.handleKey('', ENTER);
      await flush();
      await flush();
      expect(warn).toBeTypeOf('function'); // driveHome really passed one

      warn?.({ thresholdPct: 90, limitMicrocents: 1000 });
      const transcript =
        props.controller.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
      expect(transcript.some((e) => (e.text ?? '').includes('budget warning'))).toBe(true);
      expect(errs.join('')).not.toContain('budget warning');

      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await flush();
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await drivePromise;
    });
  });

  describe('copy-on-select', () => {
    const captureProps = async (over: Partial<HomeDeps>): Promise<RootAppProps> => {
      let captured: RootAppProps | undefined;
      const made = makeDeps((p) => (captured = p), over);
      const drivePromise = driveHome({ ...made.deps, ...over });
      const props = captured;
      if (props === undefined) throw new Error('the injected render was never invoked');
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms (ADR-0115 §1)
      await drivePromise;
      return props;
    };

    it('is ON by default: the ink tree gets a clipboard', async () => {
      const props = await captureProps({});
      expect(props.clipboard).toBeTypeOf('function');
    });

    it('`copy_on_select = false` withholds the clipboard from the ink tree', async () => {
      const cfg = join(cwd, 'copy-off.toml');
      writeFileSync(cfg, '[preferences]\ncopy_on_select = false\n');
      const props = await captureProps({ global: { ...global, configPath: cfg } });
      expect(props.clipboard).toBeUndefined();
      expect(props.reviewClipboard).toBeTypeOf('function');
    });

    it('`--no-mouse` withholds it too — there is no selection to copy', async () => {
      // Structural, not a second check: `resolveCopyOnSelect` takes the ALREADY-RESOLVED mouse decision.
      const props = await captureProps({ global: { ...global, noMouse: true } });
      expect(props.clipboard).toBeUndefined();
      expect(props.reviewClipboard).toBeTypeOf('function');
    });

    it('keeps explicit review copy available in inline mode', async () => {
      const props = await captureProps({ global: { ...global, noAltScreen: true } });
      expect(props.clipboard).toBeUndefined();
      expect(props.reviewClipboard).toBeTypeOf('function');
    });

    it('`copy_on_select = true` with `--no-mouse` STILL withholds it', async () => {
      const cfg = join(cwd, 'copy-on-nomouse.toml');
      writeFileSync(cfg, '[preferences]\ncopy_on_select = true\n');
      const props = await captureProps({ global: { ...global, configPath: cfg, noMouse: true } });
      expect(props.clipboard).toBeUndefined();
      expect(props.reviewClipboard).toBeTypeOf('function');
    });
  });

  /**
   * A KEYBOARD Ctrl-C DURING A HATCH (2.6.F Step 6g, whole-phase Opus review — rated critical by three lenses).
   *
   * A `/scrollback` or `/edit` suspension turns raw mode OFF, so the kernel resumes translating Ctrl-C into a real
   * SIGINT. On `relavium chat` that signal is DROPPED (`onSigintGated`, since Step 5d) and the hatch's own listener
   * resumes the renderer. The Home never had that gate: the signal tore the whole session down behind the
   * suspension's back, whose `reclaim` then re-emitted ENABLE_MOUSE on the way out — leaving DECSET 1002+1006 live
   * on the user's shell, where every subsequent click types escape bytes.
   */
  describe('a keyboard Ctrl-C during a hatch does not tear the Home down', () => {
    const drive = (): ReturnType<typeof makeDeps> & {
      exitProcess: ReturnType<typeof vi.fn>;
      port: SuspendPort;
    } => {
      const exitProcess = vi.fn();
      let captured: RootAppProps | undefined;
      const made = makeDeps((p) => (captured = p));
      void driveHome({ ...made.deps, exit: exitProcess as (code: number) => void }).catch(
        () => undefined,
      );
      const props = captured;
      if (props?.suspendPort === undefined) throw new Error('driveHome passed no suspend port');
      // `RootApp` attaches ink's `suspendTerminal` on mount; the INJECTED render does not, so stand in for it.
      props.suspendPort.attach((callback) => callback());
      return { ...made, exitProcess, port: props.suspendPort };
    };

    it('SIGINT while SUSPENDED is dropped — no exit, no terminal restore behind the hatch’s back', async () => {
      const d = drive();
      let sawSuspended = false;
      await d.port.current()?.(() => {
        sawSuspended = d.port.isSuspended();
        d.signalHandlers[0]?.(2); // the keyboard Ctrl-C
        return Promise.resolve();
      });
      expect(sawSuspended).toBe(true); // the port really was suspended when the signal arrived
      expect(d.exitProcess).not.toHaveBeenCalled();
      expect(d.writeControl.mock.calls.map((c) => c[0] as string)).not.toContain(DISABLE_MOUSE);
    });

    it('SIGINT when NOT suspended still exits 130 — the cooperative teardown is unchanged', () => {
      const d = drive();
      d.signalHandlers[0]?.(2);
      expect(d.writeControl.mock.calls.map((c) => c[0] as string)).toContain(DISABLE_MOUSE);
    });

    it.each([
      ['SIGTERM', 15],
      ['SIGHUP', 1],
      ['SIGQUIT', 3],
    ])(
      'an EXTERNAL %s tears down even while suspended — only SIGINT is the hatch’s',
      async (_n, signo) => {
        const d = drive();
        await d.port.current()?.(() => {
          d.signalHandlers[0]?.(signo);
          return Promise.resolve();
        });
        expect(d.writeControl.mock.calls.map((c) => c[0] as string)).toContain(DISABLE_MOUSE);
      },
    );
  });

  describe('the terminal is restored on EVERY termination path', () => {
    const drive = (): ReturnType<typeof makeDeps> & { exitProcess: ReturnType<typeof vi.fn> } => {
      const exitProcess = vi.fn();
      let captured: RootAppProps | undefined;
      const made = makeDeps((p) => (captured = p));
      const deps: HomeDeps = { ...made.deps, exit: exitProcess as (code: number) => void };
      void driveHome(deps).catch(() => undefined); // never resolves once a signal fires — see the docstring
      if (captured === undefined) throw new Error('the injected render was never invoked');
      return { ...made, exitProcess };
    };

    const controlsOf = (d: { writeControl: ReturnType<typeof vi.fn> }): string[] =>
      d.writeControl.mock.calls.map((c) => c[0] as string);

    it.each([
      ['SIGINT', 2],
      ['SIGTERM', 15],
      ['SIGHUP', 1],
      ['SIGQUIT', 3],
    ])('%s disables mouse reporting before anything else can run', (_name, signo) => {
      const d = drive();
      expect(d.signalHandlers).toHaveLength(1);
      d.signalHandlers[0]?.(signo);
      expect(controlsOf(d)).toContain(DISABLE_MOUSE);
      expect(controlsOf(d)).toContain(DISABLE_BRACKETED_PASTE);
    });

    it('the PRODUCTION subscriber registers all four signals, and unsubscribing removes them', () => {
      // The `it.each` above drives an INJECTED subscriber, so it would stay green if `defaultSubscribeSignals` forgot
      // SIGHUP — which is exactly the bug this step fixes. Pin the real thing against `process` itself.
      const before = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const).map((s_) =>
        process.listenerCount(s_),
      );
      const seen: number[] = [];
      const off = defaultSubscribeSignals((signo) => seen.push(signo));
      try {
        const after = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const).map((s_) =>
          process.listenerCount(s_),
        );
        expect(after).toEqual(before.map((n) => n + 1));
        process.emit('SIGHUP');
        process.emit('SIGQUIT');
        expect(seen).toEqual([1, 3]); // the conventional signo, so the exit code is 128+signo
      } finally {
        off();
      }
      const restored = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const).map((s_) =>
        process.listenerCount(s_),
      );
      expect(restored).toEqual(before); // no listener outlives the drive
    });

    it('the PRODUCTION exit net registers on `process` and is removable', () => {
      const before = process.listenerCount('exit');
      let fired = 0;
      const off = defaultSubscribeProcessExit(() => (fired += 1));
      try {
        expect(process.listenerCount('exit')).toBe(before + 1);
        process.emit('exit', 0);
        expect(fired).toBe(1);
      } finally {
        off();
      }
      expect(process.listenerCount('exit')).toBe(before);
    });

    it('a `process.exit()` that never unwinds the finally is still caught by the exit net', () => {
      const d = drive();
      expect(d.exitHandlers).toHaveLength(1);
      d.exitHandlers[0]?.(); // Node's synchronous 'exit' event
      expect(controlsOf(d)).toContain(DISABLE_MOUSE);
    });

    it('the restore is IDEMPOTENT — overlapping nets must not write DISABLE_MOUSE twice', () => {
      const d = drive();
      d.exitHandlers[0]?.();
      d.exitHandlers[0]?.();
      d.signalHandlers[0]?.(1);
      expect(controlsOf(d).filter((c) => c === DISABLE_MOUSE)).toHaveLength(1);
      expect(d.unmount).toHaveBeenCalledTimes(1);
    });

    it('a step that THROWS on one net is RETRIED by the next — the latch is per-op, set only on success', () => {
      // A transient EIO on a `writeControl` used to trip a single latch and make every later net decline to retry,
      // stranding mouse reporting on the shell (Step-6h review). `DISABLE_MOUSE` fails on the first exit-net call and
      // succeeds on the second (the signal handler).
      const writes: string[] = [];
      let failMouseOnce = true;
      let captured: RootAppProps | undefined;
      const exitHandlers: (() => void)[] = [];
      const signalHandlers: ((signo: number) => void)[] = [];
      const made = makeDeps((p) => (captured = p), {
        writeControl: (seq: string) => {
          if (seq === DISABLE_MOUSE && failMouseOnce) {
            failMouseOnce = false;
            throw new Error('EIO');
          }
          writes.push(seq);
        },
        subscribeProcessExit: (onExit) => {
          exitHandlers.push(onExit);
          return () => undefined;
        },
        subscribeSignals: (onSignal) => {
          signalHandlers.push(onSignal);
          return () => undefined;
        },
        exit: vi.fn() as unknown as (code: number) => void,
      });
      void driveHome(made.deps).catch(() => undefined);
      if (captured === undefined) throw new Error('the injected render was never invoked');

      exitHandlers[0]?.(); // DISABLE_MOUSE throws here — the latch must stay down
      expect(writes).not.toContain(DISABLE_MOUSE);
      signalHandlers[0]?.(1); // the retry succeeds
      expect(writes).toContain(DISABLE_MOUSE);
    });
  });
});
