/**
 * The shared database stays open under a hosted leg the Home had to abandon, through the PRODUCTION (owned) path
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6).
 *
 * `post-exit-line.test.ts` pins the unowned branch of `driveHome`, where the Home closes the connection itself. With an invocation the
 * connection is the SURFACE's: `SessionHomeLifetime` closes it in its database tail, whatever the Home decided. So the Home has to tell
 * the lifetime to keep it (`retainStore`) when the run host reports an abandoned leg. This file mounts the Home WITH an invocation,
 * starts a real leg that ignores its cancel, confirms the exit, and runs the host's settle bound out on the test's own clock: the
 * connection must still be open when the Home has returned.
 *
 * The Home's grace is set to one millisecond for this file (the exit is not what is under test; the tail after it is). Every timer of
 * the host is the test's own clock, and every home is a temporary directory handed to the Home and the host.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  WorkflowEngine,
  createInMemoryHost,
  type RunDeparture,
  type RunHandle,
} from '@relavium/core';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { GlobalOptions } from '../process/options.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome, type HomeDeps, type OnboardingTerminalLifecycle } from './drive-home.js';
import { HOSTED_LEG_SETTLE_BOUND_MS, RunHost } from './run-host.js';

// The Home's grace for a confirmed exit is the engine's ten seconds; this file is not about that wait, so it is one millisecond.
vi.mock('../render/tui/tui-constants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../render/tui/tui-constants.js')>()),
  HOSTED_RUN_EXIT_GRACE_MS: 1,
}));

/** The one named bound of every wait in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: abandon-owned
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

const DETACHED: Exclude<RunDeparture, { readonly kind: 'continue' }> = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

const CTRL_C = { ctrl: true } as const;
const CTRL_Y = { ctrl: true } as const;
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

let root: string;
let operatorHome: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-abandon-owned-'));
  operatorHome = join(root, 'operator-home');
  mkdirSync(operatorHome);
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A virtual clock for the host's one timer: callbacks fire in order as it is advanced, and what is still pending can be counted. */
function virtualClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { readonly at: number; readonly run: () => void }>();
  return {
    schedule: (run: () => void, delayMs: number): (() => void) => {
      next += 1;
      const id = next;
      pending.set(id, { at: now + delayMs, run });
      return () => {
        pending.delete(id);
      };
    },
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
    pending: (): number => pending.size,
  };
}

/** A handle whose stream stays open until `release()` and whose `cancel` does nothing: a leg that ignores its stop. */
function stubbornHandle() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn();
  const event: RunEvent = {
    runId: 'run-stubborn',
    timestamp: '2026-11-23T00:00:00.000Z',
    sequenceNumber: 1,
    type: 'run:cancelled',
  };
  const handle: RunHandle = {
    runId: 'run-stubborn',
    events: (async function* (): AsyncGenerator<RunEvent> {
      await held;
      yield event;
    })(),
    subscribe: () => () => undefined,
    cancel,
    depart: () => Promise.resolve(DETACHED),
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => 'durable',
    terminalError: () => undefined,
  };
  return { handle, release, cancel };
}

describe('the owned Home and an abandoned hosted leg', () => {
  it('leaves the shared database open after the grace and the settle bound ran out under a leg that ignored its cancel', async () => {
    const f = invocationFixture();
    const clock = virtualClock();
    const stubborn = stubbornHandle();
    const host = new RunHost({
      invocation: f.invocation,
      io: captureIo().io,
      global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
      db: client.db,
      homeDir: operatorHome,
      buildEngine: () => {
        const engine = new WorkflowEngine({
          host: createInMemoryHost(),
          executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
        });
        vi.spyOn(engine, 'start').mockReturnValue(stubborn.handle);
        return Promise.resolve(engine);
      },
      sweepMedia: () => Promise.resolve(undefined),
      schedule: clock.schedule,
    });
    const path = join(root, 'abandon-owned.relavium.yaml');
    writeFileSync(path, WORKFLOW);
    const launch = await host.start({ workflow: path, rawInputs: { n: '3' } });
    if (launch.kind !== 'started') throw new Error(`expected a started leg, got ${launch.kind}`);

    const closeSpy = vi.fn();
    const opened: OpenedSessionStore = {
      store: createSessionStore(client.db),
      db: client.db,
      close: closeSpy,
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
      onboardingTerminalLifecycle: INERT_ONBOARDING_TERMINAL,
      writeControl: () => undefined,
      exit: () => undefined,
      onboardingPrompter: {
        intro: () => undefined,
        outro: () => undefined,
        note: () => undefined,
        select: () => Promise.resolve(Symbol('cancel')),
        password: () => Promise.resolve(Symbol('cancel')),
        isCancel: (v): v is symbol => typeof v === 'symbol',
      },
      run: host,
      // THE OWNED PATH: the Home holds the invocation, so the connection is the surface's to close.
      invocation: f.invocation,
    };

    const running = driveHome(deps);
    await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: WAIT_MS });
    const props = captured;
    if (props === undefined) throw new Error('Home not mounted');
    expect(host.snapshot().active?.runId, 'a leg is executing').toBe('run-stubborn');

    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // a leg is executing: the second press asks
    await vi.waitFor(() => expect(props.controller.getSnapshot().exitGuard).toBe('confirm'), {
      timeout: WAIT_MS,
    });
    props.controller.bindHomeFrame(() => true); // the host measured the card on screen (this mount paints nothing)
    props.controller.handleKey('y', CTRL_Y);
    expect(stubborn.cancel, 'the leg was asked to stop, and ignores it').toHaveBeenCalled();

    // The grace ran out: the Home's exit now joins the host, which waits its own bound on the test's clock.
    await vi.waitFor(() => expect(clock.pending(), 'the host`s bound is armed').toBe(1), {
      timeout: WAIT_MS,
    });
    expect(host.abandoned).toBe(false);
    clock.advance(HOSTED_LEG_SETTLE_BOUND_MS);
    const code = await running;

    expect(host.abandoned, 'the leg was given up on').toBe(true);
    expect(
      f.registry.termination,
      'the finite-exit bound is armed: it ends the process',
    ).toBeDefined();
    expect(code).toBeTypeOf('number');
    expect(
      closeSpy,
      'the surface`s database tail did NOT close the connection the abandoned leg may still write to',
    ).not.toHaveBeenCalled();
    expect(client.sqlite.open, 'the shared database is still open').toBe(true);

    // The leg that ignored the stop finishes later and can still write.
    stubborn.release();
    const end = await launch.ended;
    expect(end.runId).toBe('run-stubborn');
    expect(client.sqlite.open).toBe(true);
  });
});
