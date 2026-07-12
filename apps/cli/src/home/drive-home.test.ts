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
import { DISABLE_MOUSE, ENABLE_MOUSE } from '../render/alt-screen.js';
import type { SuspendPort } from '../render/suspend.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import {
  defaultSubscribeProcessExit,
  defaultSubscribeSignals,
  driveHome,
  type HomeDeps,
} from './drive-home.js';

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
      subscribeSignals: (onSignal) => {
        signalHandlers.push(onSignal);
        return () => undefined;
      }, // no real process listeners in the default tests
      subscribeProcessExit: (onExit) => {
        exitHandlers.push(onExit);
        return () => undefined;
      },
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
    // DECSET 2004 (bracketed paste) + mouse reporting are disabled on exit as belt-and-suspenders (guarding a signal
    // that skips ink's own unmount cleanup) — so a clean exit restores both native paste + mouse text-selection.
    const controls = writeControl.mock.calls.map((c) => c[0] as string);
    expect(controls).toContain(DISABLE_BRACKETED_PASTE);
    expect(controls).toContain(DISABLE_MOUSE);
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

    // F1 (2.6.C) — the RENDERED conversation carries too, which is what this test's name always claimed and never
    // checked. Before the fix the reseat seeded `transcript: []`, so on the full-screen renderer (whose viewport
    // windows the store's in-memory transcript, with no native scrollback behind it) the whole conversation vanished
    // from the screen. The durable row was always intact; this asserts the VIEW. The switch notice lands LAST, so the
    // user reads the prior conversation with an inline "model changed" marker beneath it.
    const carried = reseated?.store.getSnapshot().state.transcript ?? [];
    expect(carried.map((e) => e.role)).toEqual(['user', 'assistant', 'notice']);
    expect(carried.some((e) => e.text.includes('sonnet reply'))).toBe(true); // the OLD model's answer survived
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
      await flush();
      props.controller.handleKey('c', CTRL_C); // Home Ctrl-C ⇒ clean exit
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
      await flush();
      props.controller.handleKey('c', CTRL_C);
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
    });

    it('`--no-mouse` withholds it too — there is no selection to copy', async () => {
      // Structural, not a second check: `resolveCopyOnSelect` takes the ALREADY-RESOLVED mouse decision.
      const props = await captureProps({ global: { ...global, noMouse: true } });
      expect(props.clipboard).toBeUndefined();
    });

    it('`copy_on_select = true` with `--no-mouse` STILL withholds it', async () => {
      const cfg = join(cwd, 'copy-on-nomouse.toml');
      writeFileSync(cfg, '[preferences]\ncopy_on_select = true\n');
      const props = await captureProps({ global: { ...global, configPath: cfg, noMouse: true } });
      expect(props.clipboard).toBeUndefined();
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
