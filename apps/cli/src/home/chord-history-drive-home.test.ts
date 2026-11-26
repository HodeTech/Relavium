/**
 * `driveHome` hands ONE chord history to the prompt channel and to the controller
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * `chord-history-wiring.test.ts` builds the pieces the way `driveHome` does; this file runs `driveHome` itself, because the two hand-offs
 * (`createNativePromptChannel({ history })` and `createHomeController({ chordHistory })`) are lines of its own and the only thing that
 * would notice one of them gone. The observable is the typeahead layer: a key typed while a prompt flow is open (`unseenInput`, the
 * channel's) is a FOREIGN key in the history it shares with the controller's gate card, so a `Ctrl+Y` on that card within the typeahead
 * window is refused, and one after it counts. With the channel on a history of its own the card never hears of that key.
 *
 * The clock is vitest's fake `performance` (the guard's default clock), advanced by hand; nothing else is faked and nothing sleeps. The
 * run host's `resume` is scripted and every home is a temporary directory handed to the Home.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { GlobalOptions } from '../process/options.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo, seedRun } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';
import { RunHost, type HostedLaunch } from './run-host.js';

/**
 * The bound of every wait in this file, in turns of the event loop. `vi.waitFor` is not used: with fake timers on it advances them by its
 * interval at every poll, and the clock of these tests is the thing under test.
 */
const WAIT_TURNS = 500;
const RUN = 'run-wired';
const CTRL_C = { ctrl: true } as const;
const CTRL_Y = { ctrl: true } as const;
const DOWN = { downArrow: true } as const;
const ENTER = { return: true } as const;
const INERT_JOB_CONTROL: JobControlLifecycle = {
  supported: false,
  onSuspend: () => () => undefined,
  onContinue: () => () => undefined,
  suspendSelf: () => undefined,
};
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

let root: string;
let operatorHome: string;
let client: DbClient;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance'] });
  root = mkdtempSync(join(tmpdir(), 'relavium-chord-wired-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'relavium-chord-wired-home-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  vi.useRealTimers();
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(operatorHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Turn the event loop until `predicate` holds, and FAIL when it does not within {@link WAIT_TURNS}. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < WAIT_TURNS; n += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error(`${what} was not reached within ${String(WAIT_TURNS)} turns`);
}

/** The Home over an injected mount (no TTY), with the run host's `resume` held until the test lets it go. */
async function mountHome() {
  await seedRun(client.db, {
    slug: 'wf',
    runId: RUN,
    state: 'paused',
    gate: { gateId: 'g1', gateType: 'approval', message: 'Ship it?' },
  });
  client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(root, RUN);

  const run = new RunHost({
    invocation: invocationFixture().invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: operatorHome,
  });
  let releaseResume: (launch: HostedLaunch) => void = () => undefined;
  const resume = vi.spyOn(run, 'resume').mockImplementation(
    () =>
      new Promise<HostedLaunch>((resolve) => {
        releaseResume = resolve;
      }),
  );

  const opened: OpenedSessionStore = {
    store: createSessionStore(client.db),
    db: client.db,
    close: vi.fn(),
  };
  const io: CliIo = {
    writeOut: () => undefined,
    writeErr: () => undefined,
    writeOutAcknowledged: () => Promise.resolve(),
    writeErrAcknowledged: () => Promise.resolve(),
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: Readable.from([]),
  };
  const global: GlobalOptions = {
    json: false,
    color: false,
    cwd: root,
    configPath: join(tmpdir(), 'no-such-relavium-config.toml'),
    verbosity: 'normal',
  };
  let captured: RootAppProps | undefined;
  let acknowledgeExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    acknowledgeExit = resolve;
  });
  const deps: HomeDeps = {
    homeDir: operatorHome,
    outputStoreFactory: () => Promise.resolve(undefined),
    io,
    global,
    providers: scriptedResolver([textTurn('hello')]),
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    openSessionStore: () => opened,
    now: () => 1_750_000_000_000,
    uuid: (() => {
      let n = 0;
      return () => `id-${String(n++)}`;
    })(),
    render: (props) => {
      captured = props;
      props.nativePrompt?.bindVisibility(
        (expected) => props.nativePrompt?.getSnapshot() === expected,
      );
      props.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return {
        unmount: () => acknowledgeExit(),
        waitUntilRenderFlush: () => Promise.resolve(),
        waitUntilExit: () => exited,
      };
    },
    getSize: () => ({ cols: 120, rows: 40 }),
    subscribeResize: () => () => undefined,
    subscribeSignals: () => () => undefined,
    subscribeProcessExit: () => () => undefined,
    jobControlLifecycle: INERT_JOB_CONTROL,
    writeControl: () => undefined,
    exit: () => undefined,
    firstRunSetup: 'off',
    // the keys are driven with no renderer: the Home's pages swap instead of sliding (MVP-11 unit 7)
    pageSlide: false,
    run,
  };
  const running = driveHome(deps);
  await until(() => captured !== undefined, 'the Home mounting');
  const props = captured;
  if (props === undefined) throw new Error('Home not mounted');
  // The host's evidence that the frames are on screen: this file proves the history, not the painting.
  props.controller.bindGateCardFrame(() => true);
  props.controller.bindHomeFrame(() => true);
  return {
    props,
    running,
    resume,
    release: (launch: HostedLaunch = STARTED): void => releaseResume(launch),
    /** `↓` onto the parked row and `Enter`: the card of the run, as a person opens it. */
    openCard: (): void => {
      // From the landing (MVP-11 unit 7): a card closed earlier left the Home on its work page, and `Esc` goes back up first.
      if (props.controller.getSnapshot().homePage === 'work')
        props.controller.handleKey('', { escape: true });
      props.controller.handleKey('', DOWN);
      props.controller.handleKey('', ENTER);
      expect(props.controller.getSnapshot().screen?.kind, 'the gate card is open').toBe(
        'gate-card',
      );
      const screen = props.controller.getSnapshot().screen;
      if (screen?.kind === 'gate-card') screen.card.shown(screen.card.getSnapshot());
    },
    leave: async (): Promise<number> => {
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms
      return running;
    },
  };
}

describe('driveHome shares one chord history between the prompt channel and the controller`s cards', () => {
  it('a key typed while a prompt flow is open locks a gate card that opens straight after, and not one that opens well after', async () => {
    const h = await mountHome();
    expect(h.props.controller.getSnapshot().parkedRuns.map((row) => row.runId)).toEqual([RUN]);

    // t = 1000 ms: the first card (opened at 0) is answered, so the prompt flow opens around the resume (busy) and stays open while the
    // leg prepares.
    h.openCard();
    vi.advanceTimersByTime(1_000);
    h.props.controller.handleKey('y', CTRL_Y);
    await until(() => h.resume.mock.calls.length === 1, 'the answer reaching the run host');
    expect(h.props.nativePrompt?.getSnapshot().active, 'the flow is open around the resume').toBe(
      true,
    );

    // t = 2400 ms: the person types into the composer while it is. That key is the channel's, and the controller's cards must hear of it.
    vi.advanceTimersByTime(1_400);
    h.props.nativePrompt?.unseenInput();
    h.release();
    await until(() => h.props.nativePrompt?.getSnapshot().active === false, 'the flow closing');
    h.props.controller.closeScreen();

    // t = 2500 ms: the card opens again. At 3500 ms the answer's two seconds are over (1000 -> 3000), but the typed key is 1.1 s old.
    vi.advanceTimersByTime(100);
    h.openCard();
    vi.advanceTimersByTime(1_000);
    h.props.controller.handleKey('y', CTRL_Y);
    expect(
      h.resume,
      'refused: a key was typed 1.1 s ago, in the history the channel shares',
    ).toHaveBeenCalledOnce();

    // The refused key restarted nothing it could hold (no card was answered inside the window), and the typeahead lapses 1.5 s on.
    vi.advanceTimersByTime(2_000);
    h.props.controller.handleKey('y', CTRL_Y);
    await until(() => h.resume.mock.calls.length === 2, 'the second answer reaching the run host');
    h.release();
    await until(() => h.props.nativePrompt?.getSnapshot().active === false, 'the flow closing');
    h.props.controller.closeScreen();
    expect(await h.leave()).toBe(0);
  });
});
