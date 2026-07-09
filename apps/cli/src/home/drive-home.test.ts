import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { ProviderResolver } from '../engine/providers.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { ClackOnboardingDeps } from '../onboarding/wizard.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
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
      // A cancel-immediately onboarding prompter by DEFAULT, so a key-less resolver (e.g. the real keychain-backed
      // resolver over the mocked empty keychain) never invokes the REAL clack prompts in a test (which would render
      // to stdout / block). A wizard-specific test overrides this with a scripted flow.
      onboardingPrompter: CANCEL_ONBOARDING,
      ...overrides,
    };
    return { deps, unmount, writeControl };
  }

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
    // DECSET 2004 is disabled on exit as belt-and-suspenders (ink 7's usePaste enables it natively on mount, not
    // via writeControl; this teardown write guards against a signal that skips the usePaste unmount cleanup).
    expect(writeControl.mock.calls.at(-1)?.[0]).toBe(DISABLE_BRACKETED_PASTE);
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
          return { unmount: vi.fn() };
        },
        ...over,
      });
      const done = driveHome(deps);
      if (props === undefined) throw new Error('the injected render was never invoked');
      props.controller.handleKey('c', CTRL_C); // clean Home exit ⇒ driveHome resolves
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
    await flush();
    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });

  it('in-Home /models reseat: the REAL reseatChat resumes the session under the switched model, carrying the transcript (ADR-0059)', async () => {
    // Exercises the REAL drive-home reseatChat builder (loadFull → swapAgentModel → buildResumedChatSession → seeded
    // store) end-to-end — not the mocked controller-level test — pinning the build-first swap over the same sessionId.
    let captured: RootAppProps | undefined;
    const { deps } = makeDeps((p) => (captured = p), {
      providers: scriptedResolver([textTurn('sonnet reply'), textTurn('opus reply')]),
    });
    const drivePromise = driveHome(deps);
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');

    // Start a chat (bound to the default claude-sonnet-4-6) + run one turn so the transcript persists.
    type(props, 'first');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(props.controller.getSnapshot().mode).toBe('chat');
    const oldSession = props.controller.getSnapshot().session;
    const sessionId = oldSession?.sessionId ?? '';
    expect(sessionId).not.toBe('');

    // Open the reseat picker from the chat palette, filter to a DIFFERENT available model (opus), accept.
    props.controller.handleKey('/', {});
    type(props, 'models');
    props.controller.handleKey('', ENTER);
    await flush();
    expect(props.controller.getSnapshot().modelPicker).toBeDefined();
    type(props, 'opus'); // filter to claude-opus-4-8 (registry-priced anthropic ⇒ available on the scripted key)
    props.controller.handleKey('', ENTER); // opus is reasoning-capable ⇒ the ADR-0066 effort sub-step (not an
    // immediate reseat). The picker advanced to the effort phase over the pending model.
    const effortPicker = props.controller.getSnapshot().modelPicker;
    expect(effortPicker?.phase).toBe('effort');
    expect(effortPicker?.pending?.modelId).toBe('claude-opus-4-8');
    props.controller.handleKey('', ENTER); // apply the highlighted tier (default 'medium') ⇒ the REAL reseatChat
    await flush();

    // The session was reseated: a NEW session object, the SAME sessionId, bound to opus, carrying the prior turn.
    const reseated = props.controller.getSnapshot().session;
    expect(reseated).not.toBe(oldSession); // swapped in a new instance
    expect(reseated?.sessionId).toBe(sessionId); // a reseat CONTINUES the same session (unlike /clear's new id)
    expect(reseated?.store.getSnapshot().state.model).toBe('claude-opus-4-8'); // rebound to the picked model
    expect(reseated?.store.getSnapshot().state.turnCount).toBe(1); // the prior turn carried
    // The effort sub-step's tier bound onto the reseated agent (ADR-0066) — surfaced in the footer via the store.
    expect(reseated?.store.getSnapshot().reasoningEffort).toBe('medium');
    expect(props.controller.getSnapshot().modelPicker).toBeUndefined(); // the picker closed
    expect(props.controller.getSnapshot().mode).toBe('chat'); // stayed in chat

    // The durable row's agent snapshot updates to the switched model after the reseated session ends.
    props.controller.handleKey('c', CTRL_C); // /cancel ⇒ back to Home (the reseated session's terminal writes 'ended')
    await flush();
    const full = createSessionStore(client.db).loadFull(sessionId);
    expect(full?.session.agentSnapshot?.model).toBe('claude-opus-4-8');
    expect(full?.session.agentSnapshot?.reasoning_effort).toBe('medium'); // the effort tier persisted onto the snapshot
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant']); // the single carried exchange

    props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
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
    expect(await drivePromise).toBe(EXIT_CODES.success);
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
