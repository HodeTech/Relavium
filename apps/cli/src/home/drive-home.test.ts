import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import { driveHome, type HomeDeps } from './drive-home.js';

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
const type = (props: RootAppProps, text: string): void => {
  for (const ch of text) props.controller.handleKey(ch, {});
};
const ENTER = { return: true } as const;
const CTRL_C = { ctrl: true } as const;

describe('driveHome (2.5.B / ADR-0054)', () => {
  let client: DbClient;
  let closeSpy: ReturnType<typeof vi.fn>;
  let cwd: string;

  const io: CliIo = {
    writeOut: () => undefined,
    writeErr: () => undefined,
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: Readable.from([]), // a real, already-ended stream (driveHome never reads it)
  };

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    closeSpy = vi.fn();
    cwd = mkdtempSync(join(tmpdir(), 'relavium-home-'));
  });
  afterEach(() => {
    client.sqlite.close();
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
  ): { deps: HomeDeps; unmount: ReturnType<typeof vi.fn>; writeControl: ReturnType<typeof vi.fn> } {
    const opened: OpenedSessionStore = {
      store: createSessionStore(client.db),
      db: client.db,
      close: closeSpy,
    };
    const unmount = vi.fn();
    const writeControl = vi.fn();
    let uuidN = 0;
    const deps: HomeDeps = {
      io,
      global,
      providers: scriptedResolver([textTurn('hello from the agent')]),
      openSessionStore: () => opened,
      now: () => 1_750_000_000_000,
      uuid: () => `id-${uuidN++}`, // unique per call (mirrors production randomUUID): the session id + message ids never collide
      render: (props) => {
        capture(props);
        return { unmount };
      },
      getSize: () => ({ cols: 120, rows: 40 }),
      subscribeResize: () => () => undefined,
      subscribeSignals: () => () => undefined, // no real process listeners in the default tests
      writeControl,
      exit: () => undefined,
      ...overrides,
    };
    return { deps, unmount, writeControl };
  }

  it('an init fault after the db is open (a throwing writeControl) still closes the db once', async () => {
    // The cleanup scope opens right after `opened`, and the inner finally guarantees the close even though the
    // terminal-restore writeControl also throws — so a faulty terminal can never leak the db handle.
    const writeControl = vi.fn(() => {
      throw new Error('stdout write failed');
    });
    const { deps } = makeDeps(() => undefined, { writeControl });
    await expect(driveHome(deps)).rejects.toThrow('stdout write failed');
    expect(closeSpy).toHaveBeenCalledTimes(1);
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
        };
      },
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    props.controller.handleKey('c', CTRL_C);
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

    expect(await drivePromise).toBe(EXIT_CODES.success);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
    // DECSET 2004 enabled on mount, disabled on exit.
    expect(writeControl.mock.calls[0]?.[0]).toBe(ENABLE_BRACKETED_PASTE);
    expect(writeControl.mock.calls.at(-1)?.[0]).toBe(DISABLE_BRACKETED_PASTE);
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
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('startChat builds the default-agent session and persists its row; a clean return ends it', async () => {
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p));
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    type(props, 'hello');
    props.controller.handleKey('', ENTER); // submit ⇒ build + first turn
    await flush();
    expect(props.controller.getSnapshot().mode).toBe('chat');

    const sessions = createSessionStore(client.db);
    expect(sessions.listSessions({ limit: 10 })).toHaveLength(1); // the chat persisted its row

    props.controller.handleKey('c', CTRL_C); // chat Ctrl-C ⇒ /cancel ⇒ back to Home
    await flush();
    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ exit
    expect(await drivePromise).toBe(EXIT_CODES.success);
    expect(sessions.listSessions({ limit: 10 })[0]?.status).toBe('ended');
  });

  it('a /models write is picked up by the NEXT chat started in the SAME Home process (2.5.G S7 regression)', async () => {
    // The blocker Sonnet review caught: `startChat` closed over the load-once `config` snapshot, so a `/models`
    // write never reached a same-process chat even though the notice claimed "applies to your next chat session".
    // Drive the REAL port (real config write + real re-read) end-to-end and assert the next session binds the pick.
    const configFile = join(cwd, 'home-config.toml'); // a real, writable global config (the write + re-read target)
    let captured: RootAppProps | undefined;
    const builtDefaults: Array<string | undefined> = [];
    const { deps } = makeDeps((p) => (captured = p), {
      global: { ...global, configPath: configFile },
      // Record the default the session is built with, then delegate to the real builder (so the chat still works).
      buildSession: (args) => {
        builtDefaults.push(args.chat.defaultModel);
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

    props.controller.handleKey('', ENTER); // accept ⇒ writeGlobalDefaultModel(chosen) to configFile
    expect(props.controller.getSnapshot().modelPicker).toBeUndefined(); // picker closed on accept
    expect(props.controller.getSnapshot().notice).toContain('next chat session'); // honest success (write took effect)

    // Start a chat — the NEXT session MUST bind the just-chosen model (the fresh re-read), not a stale startup default.
    type(props, 'hello');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(props.controller.getSnapshot().mode).toBe('chat');
    expect(builtDefaults.at(-1)).toBe(chosen); // the regression assertion — a stale snapshot would NOT equal `chosen`

    props.controller.handleKey('c', CTRL_C); // chat Ctrl-C ⇒ /cancel ⇒ back to Home
    await flush();
    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
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
    expect(writeControl.mock.calls.at(-1)?.[0]).toBe(DISABLE_BRACKETED_PASTE);
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
});
