/**
 * `driveHome` wires the Home's question for a media park to the run host's media resume
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment note).
 *
 * `home-media-continue.test.tsx` drives the controller with a scripted `continueMedia`, and `media-continue.test.ts` the question over a
 * scripted host; the line that joins them (`continueMedia: (runId) => runMediaContinue({ host, flow, ... })`) is `driveHome`'s own, and
 * the only thing that would notice it gone is this file: a run parked on media jobs in a real `history.db`, a real native prompt
 * channel, and the run host's `resume` spied. The observable is the request that reaches the host: a Yes sends the media form for THAT
 * run (no gate, no decision), and a No sends nothing.
 *
 * Nothing sleeps and no operator home is read: every home is a temporary directory handed to the Home.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { Key } from 'ink';
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

/** The bound of every wait in this file, in turns of the event loop. */
const WAIT_TURNS = 500;
const RUN = 'run-media-wired';
const CTRL_C = { ctrl: true } as const;
const DOWN = { downArrow: true } as const;
const ENTER = { return: true } as const;
const NO_KEY: Key = {
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
};
const PROMPT_UP: Key = { ...NO_KEY, upArrow: true };
const PROMPT_ENTER: Key = { ...NO_KEY, return: true };
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
  root = mkdtempSync(join(tmpdir(), 'relavium-media-wired-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'relavium-media-wired-home-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
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

/** The Home over an injected mount (no TTY), with a run parked on a media job and the run host's `resume` spied. */
async function mountHome() {
  // A run parked on an async media job and on nothing else: `seedRun` leaves a `media_job:submitted` and a `run:paused` that names it.
  await seedRun(client.db, { slug: 'wf', runId: RUN, state: 'paused' });
  // A run records the canonical spelling of its directory (MVP-11 unit 7, round 2): a temp directory and its realpath differ on macOS.
  client.sqlite
    .prepare('UPDATE runs SET project_root = ? WHERE id = ?')
    .run(realpathSync.native(root), RUN);

  const run = new RunHost({
    invocation: invocationFixture().invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: operatorHome,
  });
  const resume = vi.spyOn(run, 'resume').mockResolvedValue(STARTED);

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
  props.controller.bindHomeFrame(() => true);
  return {
    props,
    running,
    resume,
    /** `↓` onto the parked row and `Enter`, as a person asks the question. */
    ask: (): void => {
      props.controller.handleKey('', DOWN);
      props.controller.handleKey('', ENTER);
    },
    leave: async (): Promise<number> => {
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms
      return running;
    },
  };
}

describe('driveHome asks about a media park, and a Yes is the run host`s media resume', () => {
  it('the row says it waits for media, `Enter` opens the question on the prompt channel, and a Yes sends the media form for that run', async () => {
    const h = await mountHome();
    // the row also carries when the run parked (the run record's own time, `parkedSince`: round 2)
    expect(
      h.props.controller.getSnapshot().parkedRuns.map(({ parkedSince, ...rest }) => ({
        ...rest,
        timed: typeof parkedSince === 'string',
      })),
    ).toEqual([{ runId: RUN, kind: 'media', gates: 0, workflow: 'wf', timed: true }]);

    h.ask();
    await until(() => h.props.nativePrompt?.getSnapshot().active === true, 'the question');
    const question = h.props.nativePrompt?.getSnapshot();
    expect(question?.message).toBe(
      'Run run-medi is waiting for media jobs. Continue it here? ' +
        'It runs in this Home until the jobs finish, and leaving the Home cancels it.',
    );
    expect(question?.options[question.selected]?.label, 'the default is No').toBe('No');
    expect(h.resume, 'nothing is sent before the answer').not.toHaveBeenCalled();

    h.props.nativePrompt?.input('', PROMPT_UP); // No -> Yes
    h.props.nativePrompt?.input('', PROMPT_ENTER);
    await until(() => h.resume.mock.calls.length === 1, 'the answer reaching the run host');
    const request = h.resume.mock.calls[0]?.[0];
    if (request?.kind !== 'media') throw new Error('the host was not asked for a media resume');
    expect(request.runId).toBe(RUN);
    expect(typeof request.secrets).toBe('function');
    expect(Object.keys(request).sort(), 'no gate, no decision').toEqual([
      'kind',
      'runId',
      'secrets',
      'signal',
    ]);
    // The flow's own signal: an Esc or Ctrl+C while the leg is being prepared stops it before it starts (ADR-0139 §4).
    expect(request.signal).toBeInstanceOf(AbortSignal);
    await until(() => h.props.nativePrompt?.getSnapshot().active === false, 'the flow closing');
    expect(await h.leave()).toBe(0);
  });

  it('a No (the default) sends nothing: the run stays parked and the keyboard is back', async () => {
    const h = await mountHome();
    h.ask();
    await until(() => h.props.nativePrompt?.getSnapshot().active === true, 'the question');
    h.props.nativePrompt?.input('', PROMPT_ENTER);
    await until(() => h.props.nativePrompt?.getSnapshot().active === false, 'the flow closing');
    await until(
      () => h.props.controller.getSnapshot().nativeActionBusy === false,
      'the keyboard given back',
    );
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.props.controller.getSnapshot().parkedRuns.map((row) => row.runId)).toEqual([RUN]);
    expect(h.props.controller.getSnapshot().notice).toBeUndefined();
    expect(await h.leave()).toBe(0);
  });
});
