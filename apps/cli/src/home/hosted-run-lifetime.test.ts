/**
 * The hosted leg's lifetime is the shell's lifetime minus what the Home already owns
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1, §6).
 *
 * This file is the contract test of `RunLifetime`: the same `driveRun` scenarios run against the shell's
 * `WorkflowLifetime` and the Home's `HostedRunLifetime`, and the observable behaviour must be equal. The
 * differences the ADR specifies (signal custody, the job control, the terminal owner, how an owner-stage fault
 * is classified, what a leg that did not retire does, and which failures are published) are pinned separately,
 * so neither side can drift into the other's behaviour without a named test failing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EngineStateError,
  WorkflowEngine,
  createInMemoryHost,
  type RunDeparture,
  type RunHandle,
} from '@relavium/core';
import type { RunDurability, RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { driveRun, type RunOutcome } from '../commands/drive.js';
import { WorkflowLifetime } from '../commands/workflow-lifetime.js';
import { buildEngine } from '../engine/build-engine.js';
import type { ResolvedStdioSpawn } from '../engine/mcp-consent.js';
import { CliError } from '../process/cli-error.js';
import type { CliInvocation } from '../process/invocation.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { InvocationOwner, WorkflowOwner } from '../process/invocation-registry.js';
import { SignalCustody } from '../process/signal-custody.js';
import type { RunJobControl } from '../render/run-job-control.js';
import { prepareRun } from '../run-core/prepare-run.js';
import type { RunLifetime, RunTerminalView } from '../run-core/run-lifetime.js';
import { RunResources } from '../run-core/run-resources.js';
import { captureIo } from '../test-support.js';
import { HostedRunLifetime } from './hosted-run-lifetime.js';

let root: string;
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) =>
      actual.loadResolvedConfig({ ...options, home: root }),
  };
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-hosted-lifetime-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type HostName = 'WorkflowLifetime' | 'HostedRunLifetime';
const HOSTS: readonly HostName[] = ['WorkflowLifetime', 'HostedRunLifetime'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/** The two members a test needs beyond `RunLifetime`; both implementations have them. */
type Lifetime = RunLifetime & { readonly finish: () => Promise<unknown> };

/** The Home's own terminal view, with a count of what reached it. */
function homeView() {
  const calls = { jobControl: 0, renderer: 0, prompt: 0, viewOperation: 0, release: 0 };
  const state = { sealed: false };
  const view: RunTerminalView = {
    get sealed() {
      return state.sealed;
    },
    releaseInput: () => {
      calls.release += 1;
      return Promise.resolve();
    },
    createJobControl: (factory) => {
      calls.jobControl += 1;
      return factory(() => undefined);
    },
    createRenderer: (factory) => {
      calls.renderer += 1;
      return factory({ acknowledgeNoAcquisition: () => undefined, adopt: () => undefined });
    },
    runPrompt: (factory) => {
      calls.prompt += 1;
      return factory();
    },
    runViewOperation: (factory) => {
      calls.viewOperation += 1;
      return Promise.resolve().then(factory);
    },
  };
  return { view, calls, state };
}

interface Rig {
  readonly host: HostName;
  readonly lifetime: Lifetime;
  readonly invocation: CliInvocation;
  readonly registry: CliInvocation['registry'];
  readonly custody: SignalCustody;
  /** Every owner the lifetime registered, in order. */
  readonly registered: readonly InvocationOwner[];
  /** Owners registered before the lifetime existed (the Home's own, in production). */
  readonly baseline: number;
  readonly io: ReturnType<typeof captureIo>['io'];
  readonly err: () => string;
  readonly view: ReturnType<typeof homeView>;
}

/**
 * A lifetime in the state its host puts it in. The shell's custody is free until the lifetime claims it; the
 * Home's custody is already claimed by its own surface when a leg's lifetime is built.
 */
function rig(host: HostName, io = captureIo()): Rig {
  const f = invocationFixture();
  const custody = new SignalCustody();
  const invocation: CliInvocation = { ...f.invocation, signalCustody: custody };
  const registered: InvocationOwner[] = [];
  const register = f.registry.register.bind(f.registry);
  vi.spyOn(f.registry, 'register').mockImplementation((owner) => {
    registered.push(owner);
    return register(owner);
  });
  const baseline = f.registry.activeOwners;
  const view = homeView();
  let lifetime: Lifetime;
  if (host === 'WorkflowLifetime')
    lifetime = new WorkflowLifetime(invocation, io.io, () => () => undefined);
  else {
    custody.claim();
    lifetime = new HostedRunLifetime(invocation, view.view);
  }
  return {
    host,
    lifetime,
    invocation,
    registry: f.registry,
    custody,
    registered,
    baseline,
    io: io.io,
    err: io.err,
    view,
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Did `work` settle once every microtask had run? A promise that never settles is the failure this catches. */
async function settles(work: Promise<unknown>): Promise<boolean> {
  let done = false;
  void work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await turn();
  await turn();
  await turn();
  return done;
}

const TS = '2026-11-22T00:00:00.000Z';
type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

interface Script {
  readonly terminal: 'completed' | 'paused' | 'cancelled';
  readonly departure?: Departure;
  readonly durability?: RunDurability;
  /** The stream stays open until the host cancels the run, as a leg that is executing does. */
  readonly holdUntilCancel?: boolean;
}

function scriptedHandle(runId: string, script: Script) {
  let release: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn(() => {
    release();
  });
  const base = { runId, timestamp: TS, sequenceNumber: 1 };
  const events: Readonly<Record<Script['terminal'], RunEvent>> = {
    completed: {
      ...base,
      type: 'run:completed',
      outputs: {},
      totalTokensUsed: { input: 0, output: 0 },
      totalCostMicrocents: 0,
      durationMs: 1,
    },
    paused: { ...base, type: 'run:paused', pendingGateCount: 1, gateIds: ['gate-1'] },
    cancelled: { ...base, type: 'run:cancelled' },
  };
  const handle: RunHandle = {
    runId,
    events: (async function* (): AsyncGenerator<RunEvent> {
      if (script.holdUntilCancel === true) await cancelled;
      yield events[script.terminal];
    })(),
    subscribe: () => () => undefined,
    cancel,
    depart: () => Promise.resolve(script.departure ?? DETACHED),
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => script.durability ?? 'durable',
    terminalError: () => undefined,
  };
  return { handle, cancel };
}

function inMemoryEngine(): WorkflowEngine {
  return new WorkflowEngine({
    host: createInMemoryHost(),
    executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
  });
}

interface Observation {
  readonly outcome: RunOutcome | undefined;
  readonly rendered: readonly string[];
  readonly cancelCalls: number;
  readonly signalAborted: boolean;
  readonly exitCode: number;
  readonly terminated: boolean;
  readonly infrastructure: boolean;
  readonly finished: boolean;
  readonly ownersLeft: number;
  readonly stderr: string;
}

/** Run one scripted leg through the real `driveRun` and report everything observable from outside. */
async function observeLeg(host: HostName, script: Script): Promise<Observation> {
  const r = rig(host);
  const { handle, cancel } = scriptedHandle('run-contract', script);
  const rendered: string[] = [];
  const pending = driveRun({
    lifetime: r.lifetime,
    engine: inMemoryEngine(),
    handle,
    io: r.io,
    makeRenderer: () => ({
      onEvent: (event) => {
        rendered.push(event.type);
      },
    }),
  });
  if (script.holdUntilCancel === true) {
    // The host's stop, twice: the engine is asked to cancel once.
    r.lifetime.stop();
    r.lifetime.stop();
  }
  const outcome = await pending;
  const finished = await settles(r.lifetime.finish());
  return {
    outcome,
    rendered,
    cancelCalls: cancel.mock.calls.length,
    signalAborted: r.lifetime.signal.aborted,
    exitCode: r.registry.observations.exitCode(),
    terminated: r.registry.termination !== undefined,
    infrastructure: r.registry.observations.hasInfrastructureFailure(),
    finished,
    ownersLeft: r.registry.activeOwners - r.baseline,
    stderr: r.err(),
  };
}

describe('the same drive scenarios behave the same under both hosts', () => {
  const settled = { finished: true, ownersLeft: 0, terminated: false, infrastructure: false };
  const scenarios: readonly {
    readonly name: string;
    readonly script: Script;
    readonly expected: Partial<Observation>;
  }[] = [
    {
      name: 'a leg that completes',
      script: { terminal: 'completed' },
      expected: {
        ...settled,
        outcome: 'completed',
        rendered: ['run:completed'],
        exitCode: 0,
        cancelCalls: 0,
        signalAborted: false,
      },
    },
    {
      name: 'a leg that pauses at a gate with nobody to answer inline',
      script: { terminal: 'paused' },
      expected: { ...settled, outcome: 'paused', rendered: ['run:paused'], exitCode: 0 },
    },
    {
      name: 'a leg the host stops while it runs (cancelled once, however often it is asked)',
      script: { terminal: 'cancelled', holdUntilCancel: true },
      expected: {
        ...settled,
        outcome: 'cancelled',
        rendered: ['run:cancelled'],
        cancelCalls: 1,
        signalAborted: true,
        exitCode: 0,
      },
    },
    {
      name: 'money receipts not confirmed (8)',
      script: { terminal: 'completed', departure: { ...DETACHED, moneyDurability: 'uncertain' } },
      expected: { ...settled, outcome: 'completed', exitCode: 8 },
    },
    {
      name: 'an effect that needs attention (7)',
      script: { terminal: 'completed', departure: { ...DETACHED, effectNeedsAttention: true } },
      expected: { ...settled, outcome: 'completed', exitCode: 7 },
    },
    {
      name: 'a terminal delivered whose record did not land (5)',
      script: { terminal: 'completed', durability: 'uncertain' },
      expected: { ...settled, outcome: 'completed', exitCode: 5 },
    },
    {
      name: 'a run fenced out with no terminal (6)',
      script: { terminal: 'paused', durability: 'uncertain' },
      expected: { ...settled, outcome: 'paused', exitCode: 6 },
    },
  ];

  it.each(scenarios)('$name', async ({ script, expected }) => {
    const shell = await observeLeg('WorkflowLifetime', script);
    const hosted = await observeLeg('HostedRunLifetime', script);
    expect(hosted).toEqual(shell);
    expect(shell).toMatchObject(expected);
  });
});

describe('the same lifetime operations behave the same under both hosts', () => {
  it.each(HOSTS)(
    '%s: owners are registered before any work and retire only at finish',
    async (host) => {
      const r = rig(host);
      expect(r.registered.filter((owner) => owner.kind === 'workflow')).toHaveLength(1);
      expect(r.registry.activeOwners).toBeGreaterThan(r.baseline);
      expect(await settles(r.lifetime.finish())).toBe(true);
      expect(r.registry.activeOwners).toBe(r.baseline);
    },
  );

  it.each(HOSTS)('%s: a stop makes the next checkpoint throw the leg own marker', (host) => {
    const r = rig(host);
    r.lifetime.checkpoint();
    r.lifetime.stop();
    let marker: unknown;
    try {
      r.lifetime.checkpoint();
    } catch (cause) {
      marker = cause;
    }
    expect(marker).toBeInstanceOf(Error);
    expect(r.lifetime.isStoppedFailure(marker)).toBe(true);
    expect(r.lifetime.isStoppedFailure(new Error('another'))).toBe(false);
    expect(r.lifetime.stopped).toBe(true);
    expect(r.lifetime.signal.aborted).toBe(true);
    // The stop marker is not a failure: it is neither classified nor published.
    r.lifetime.failure(marker);
    expect(r.registry.termination).toBeUndefined();
    expect(r.registry.observations.hasInfrastructureFailure()).toBe(false);
  });

  it.each(HOSTS)(
    '%s: a stop with only an engine adopted asks the engine to cancel, once',
    (host) => {
      const r = rig(host);
      const engine = inMemoryEngine();
      const cancel = vi.spyOn(engine, 'cancel').mockImplementation(() => undefined);
      r.lifetime.adoptEngine(engine, 'run-engine-only');
      r.lifetime.stop();
      r.lifetime.stop();
      expect(cancel).toHaveBeenCalledExactlyOnceWith('run-engine-only');
    },
  );

  it.each(HOSTS)('%s: an engine that no longer knows the run is not a failure', (host) => {
    const r = rig(host);
    const engine = inMemoryEngine();
    vi.spyOn(engine, 'cancel').mockImplementation(() => {
      throw new EngineStateError('run_already_terminal', 'settled');
    });
    r.lifetime.adoptEngine(engine, 'run-settled');
    r.lifetime.stop();
    expect(r.registry.termination).toBeUndefined();
    expect(r.registry.observations.hasInfrastructureFailure()).toBe(false);
  });

  it.each(HOSTS)('%s: any other cancel fault is an infrastructure failure', (host) => {
    const r = rig(host);
    const engine = inMemoryEngine();
    vi.spyOn(engine, 'cancel').mockImplementation(() => {
      throw new Error('PRIVATE_CANCEL_FAULT');
    });
    r.lifetime.adoptEngine(engine, 'run-faulty');
    r.lifetime.stop();
    expect(r.registry.termination).toBeDefined();
    expect(r.registry.observations.infrastructureCode()).toBe('cli_internal');
  });

  it.each(HOSTS)('%s: publishing never downgrades the strongest safety fact', async (host) => {
    const r = rig(host);
    // What the registry reads back from the owner at retirement and before a finite exit.
    const readSafety = (): unknown => {
      const owner = r.registered.find((candidate) => candidate.kind === 'workflow');
      return owner?.kind === 'workflow' ? owner.readSafetyExit() : 'no workflow owner';
    };
    expect(readSafety()).toBeUndefined();
    r.lifetime.publish(7, true);
    r.lifetime.publish(5, true);
    expect(r.registry.observations.exitCode()).toBe(7);
    expect(readSafety()).toBe(7);
    r.lifetime.publish(8, true);
    r.lifetime.publish(6, true);
    r.lifetime.publish(undefined, true);
    expect(r.registry.observations.exitCode()).toBe(8);
    expect(readSafety()).toBe(8);
    expect(await settles(r.lifetime.finish())).toBe(true);
    expect(r.registry.observations.exitCode(), 'a retired owner keeps its fact').toBe(8);
  });

  it.each(HOSTS)('%s: the effect-notice owner answers to the same leg', async (host) => {
    const r = rig(host);
    const owner = r.lifetime.effectNoticeOwner;
    expect(owner.signal).toBe(r.lifetime.signal);
    expect(() => owner.assertAdmitting()).not.toThrow();
    expect(await owner.work.retainWork(() => Promise.resolve(7))).toBe(7);
    r.lifetime.stop();
    expect(() => owner.assertAdmitting()).toThrow();
    owner.failure(new CliError('cli_internal', ''));
    expect(r.registry.observations.infrastructureCode()).toBe('cli_internal');
  });

  it.each(HOSTS)('%s: a sink that throws is observed once, then silenced', (host) => {
    const r = rig(host);
    const consume = vi.fn((text: string): void => {
      throw new CliError('output_unavailable', text.slice(0, 0));
    });
    const guarded = r.lifetime.notification(consume);
    guarded('first');
    guarded('second');
    expect(consume).toHaveBeenCalledOnce();
    expect(r.registry.observations.infrastructureCode()).toBe('output_unavailable');
    expect(r.registry.termination).toBeDefined();
  });

  const causes: readonly {
    readonly name: string;
    readonly cause: () => unknown;
    readonly infrastructure: 'cli_internal' | 'output_unavailable' | undefined;
  }[] = [
    {
      name: 'a classified storage refusal',
      cause: () => new CliError('storage_unavailable', 'x'),
      infrastructure: undefined,
    },
    {
      name: 'a classified invocation refusal',
      cause: () => new CliError('invalid_invocation', 'x'),
      infrastructure: undefined,
    },
    {
      name: 'a classified ownership refusal',
      cause: () => new CliError('run_owned_elsewhere', 'x'),
      infrastructure: undefined,
    },
    {
      name: 'a classified output fault',
      cause: () => new CliError('output_unavailable', ''),
      infrastructure: 'output_unavailable',
    },
    {
      name: 'an explicit infrastructure fault',
      cause: () => new CliError('cli_internal', ''),
      infrastructure: 'cli_internal',
    },
    {
      name: 'an unclassifiable error',
      cause: () => new Error('PRIVATE_OPAQUE'),
      infrastructure: 'cli_internal',
    },
  ];
  it.each(HOSTS.flatMap((host) => causes.map((c) => ({ host, ...c }))))(
    '$host: $name is infrastructure only when its own classification says so',
    ({ host, cause, infrastructure }) => {
      const r = rig(host);
      r.lifetime.failure(cause());
      expect(r.registry.observations.infrastructureCode()).toBe(infrastructure);
      expect(r.registry.observations.hasInfrastructureFailure()).toBe(infrastructure !== undefined);
      expect(r.registry.termination !== undefined).toBe(infrastructure !== undefined);
    },
  );

  it.each(HOSTS)('%s: an unacknowledged cleanup is bounded by the finite exit', (host) => {
    const r = rig(host);
    r.lifetime.cleanupFailed(new Error('PRIVATE_CLOSE'));
    expect(r.registry.observations.infrastructureCode()).toBe('cli_internal');
    expect(r.registry.budget.deadline()).toBe(3000);
    expect(r.registry.activeOwners).toBeGreaterThan(r.baseline);
  });
});

describe('where the Home deliberately differs from the shell', () => {
  it('claims no signal custody, however the Home holds it, and releases nothing of the Home', async () => {
    const shell = rig('WorkflowLifetime');
    expect(shell.custody.claimed, 'the shell lifetime owns the custody').toBe(true);

    const f = invocationFixture();
    const custody = new SignalCustody();
    const home = custody.claim(); // the Home's own surface claimed it first
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    const hosted = new HostedRunLifetime(
      { ...f.invocation, signalCustody: custody },
      homeView().view,
    );
    expect(custody.claimed).toBe(true);
    expect(await settles(hosted.finish())).toBe(true);
    expect(custody.claimed, 'finishing a leg leaves the Home claim in place').toBe(true);
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    home();
    expect(custody.claimed).toBe(false);

    // The contrast: a second claim on the same invocation is an internal fault for the shell lifetime.
    const taken = new SignalCustody();
    taken.claim();
    expect(
      () =>
        new WorkflowLifetime(
          { ...invocationFixture().invocation, signalCustody: taken },
          captureIo().io,
          () => () => undefined,
        ),
    ).toThrow(CliError);
  });

  it('does not claim the custody when it is free either, and subscribes to no signal', () => {
    const f = invocationFixture();
    const custody = new SignalCustody();
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    new HostedRunLifetime({ ...f.invocation, signalCustody: custody }, homeView().view);
    expect(custody.claimed).toBe(false);
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it('registers one workflow owner and no terminal owner, where the shell registers both', () => {
    expect(rig('WorkflowLifetime').registered.map((owner) => owner.kind)).toEqual([
      'workflow',
      'terminal',
    ]);
    expect(rig('HostedRunLifetime').registered.map((owner) => owner.kind)).toEqual(['workflow']);
  });

  it('hands the Home view everything but the job control, which is inert', async () => {
    const r = rig('HostedRunLifetime');
    const factory = vi.fn((): RunJobControl => ({ dispose: () => undefined }));
    const control = r.lifetime.terminal.createJobControl(factory);
    expect(factory).not.toHaveBeenCalled();
    expect(r.view.calls.jobControl).toBe(0);
    control.dispose();
    control.dispose();

    const shell = rig('WorkflowLifetime');
    const shellFactory = vi.fn((): RunJobControl => ({ dispose: () => undefined }));
    shell.lifetime.terminal.createJobControl(shellFactory);
    expect(shellFactory, 'the shell lifetime builds the control').toHaveBeenCalledOnce();

    r.view.state.sealed = true;
    expect(r.lifetime.terminal.sealed).toBe(true);
    await r.lifetime.terminal.releaseInput();
    await r.lifetime.terminal.runPrompt(() => Promise.resolve(1));
    await r.lifetime.terminal.runViewOperation(() => 2, false);
    r.lifetime.terminal.createRenderer(() => ({ onEvent: () => undefined }));
    expect(r.view.calls).toEqual({
      jobControl: 0,
      renderer: 1,
      prompt: 1,
      viewOperation: 1,
      release: 1,
    });
  });

  it('installs no second job control when driveRun runs on a terminal', async () => {
    const captured = captureIo();
    const r = rig('HostedRunLifetime', {
      ...captured,
      io: { ...captured.io, stdoutIsTty: true },
    });
    const before = process.listenerCount('SIGTSTP');
    const during: number[] = [];
    const { handle } = scriptedHandle('run-tty', { terminal: 'completed' });
    const outcome = await driveRun({
      lifetime: r.lifetime,
      engine: inMemoryEngine(),
      handle,
      io: r.io,
      makeRenderer: () => ({
        onEvent: () => {
          during.push(process.listenerCount('SIGTSTP'));
        },
      }),
    });
    expect(outcome).toBe('completed');
    expect(r.io.stdoutIsTty).toBe(true);
    expect(r.view.calls.jobControl, 'the Home view is never asked for a job control').toBe(0);
    expect(r.view.calls.renderer).toBe(1);
    expect(during).toEqual([before]);
    expect(process.listenerCount('SIGTSTP')).toBe(before);
  });

  it('files an owner-stage fault under its own classification, not as cli_internal', () => {
    const workflowOwner = (host: HostName): WorkflowOwner => {
      const found = rig(host).registered.find((candidate) => candidate.kind === 'workflow');
      if (found?.kind !== 'workflow') throw new Error('no workflow owner registered');
      return found;
    };
    const hosted = workflowOwner('HostedRunLifetime');
    const shell = workflowOwner('WorkflowLifetime');
    const faults = [
      [new CliError('storage_unavailable', 'x'), 'storage_unavailable'],
      [new CliError('output_unavailable', ''), 'output_unavailable'],
      [new CliError('cli_internal', ''), 'cli_internal'],
      [new CliError('internal', 'x'), 'internal'],
      [new CliError('invalid_invocation', 'x'), 'internal'],
      [new CliError('run_owned_elsewhere', 'x'), 'internal'],
      [new Error('PRIVATE_OPAQUE'), 'cli_internal'],
    ] as const;
    for (const stage of ['stop', 'join', 'retirement'] as const) {
      for (const [fault, code] of faults) {
        expect(hosted.classifyFailure(stage, fault), `${stage}: ${code}`).toBe(code);
        expect(
          shell.classifyFailure(stage, fault),
          'the shell files every one as cli_internal',
        ).toBe('cli_internal');
      }
    }
  });

  it('does not publish a leg ordinary failure as the Home exit code, where the shell does', () => {
    const shell = rig('WorkflowLifetime');
    shell.lifetime.failure(new CliError('invalid_invocation', 'x'));
    expect(shell.registry.observations.exitCode()).toBe(2);

    const hosted = rig('HostedRunLifetime');
    hosted.lifetime.failure(new CliError('invalid_invocation', 'x'));
    hosted.lifetime.failure(new CliError('storage_unavailable', 'x'));
    hosted.lifetime.failure(new CliError('run_owned_elsewhere', 'x'));
    expect(hosted.registry.observations.exitCode()).toBe(0);
    // An infrastructure fault is a fact about the Home's process, and still is published.
    hosted.lifetime.failure(new CliError('cli_internal', ''));
    expect(hosted.registry.observations.exitCode()).toBe(9);
  });

  it('returns from finish for a leg that did not retire and keeps its owner, where the shell never returns', async () => {
    const stuck = async (host: HostName) => {
      const r = rig(host);
      const { handle } = scriptedHandle('run-undeparted', { terminal: 'completed' });
      r.lifetime.adoptHandle(handle); // adopted and never departed: not host-safe
      const result = r.lifetime.finish();
      return { returned: await settles(result), result, r };
    };
    const shell = await stuck('WorkflowLifetime');
    expect(shell.returned, 'the shell keeps its process for its exit authority').toBe(false);

    const hosted = await stuck('HostedRunLifetime');
    expect(hosted.returned, 'the Home must not be left holding a promise that never settles').toBe(
      true,
    );
    expect(await hosted.result).toBe('retained');
    expect(hosted.r.registry.activeOwners, 'its owner stays registered').toBe(
      hosted.r.baseline + 1,
    );
  });

  it('retains the owner when a cleanup was not acknowledged, and still returns', async () => {
    const r = rig('HostedRunLifetime');
    r.lifetime.cleanupFailed(new Error('PRIVATE_CLOSE'));
    const result = r.lifetime.finish();
    expect(await settles(result)).toBe(true);
    expect(await result).toBe('retained');
    expect(r.registry.activeOwners).toBe(r.baseline + 1);
  });

  it('answers a second finish with the first answer', async () => {
    const r = rig('HostedRunLifetime');
    expect(await r.lifetime.finish()).toBe('retired');
    r.lifetime.cleanupFailed(new Error('PRIVATE_LATE_CLOSE'));
    expect(await r.lifetime.finish()).toBe('retired');
  });
});

describe('the owner is registered before the engine is built, and never after', () => {
  const WORKFLOW = `schema_version: '1.0'
workflow:
  id: hosted-order
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;
  const PASS_CONSENT = (): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> =>
    Promise.resolve(new Map<string, ResolvedStdioSpawn>());

  async function prepare(r: Rig, build: () => Promise<WorkflowEngine>): Promise<void> {
    const path = join(root, 'hosted-order.relavium.yaml');
    writeFileSync(path, WORKFLOW);
    const resources = new RunResources(r.lifetime, r.io);
    try {
      await prepareRun(
        { workflow: path, rawInputs: {} },
        { io: r.io, global: { cwd: root, configPath: undefined }, buildEngine: build },
        { secretInputs: () => Promise.resolve({}), consentGate: () => PASS_CONSENT },
        r.lifetime,
        resources,
      );
    } finally {
      await resources.releaseMcp();
    }
  }

  it('has the workflow owner in the registry when prepareRun builds the engine', async () => {
    const r = rig('HostedRunLifetime');
    const kindsAtBuild: string[] = [];
    const ownersAtBuild: number[] = [];
    await prepare(r, () => {
      kindsAtBuild.push(...r.registered.map((owner) => owner.kind));
      ownersAtBuild.push(r.registry.activeOwners - r.baseline);
      return buildEngine({ host: createInMemoryHost() });
    });
    expect(kindsAtBuild, 'registered before the engine was built').toEqual(['workflow']);
    expect(ownersAtBuild).toEqual([1]);
    expect(
      r.registered.map((owner) => owner.kind),
      'and nothing registers after it',
    ).toEqual(['workflow']);
    expect(await settles(r.lifetime.finish())).toBe(true);
    expect(r.registry.activeOwners).toBe(r.baseline);
  });

  it('delivers a termination that arrives during preparation to the leg, which then stops', async () => {
    const r = rig('HostedRunLifetime');
    const stopped = prepare(r, () => {
      void r.registry.terminate({ kind: 'normal' });
      return buildEngine({ host: createInMemoryHost() });
    });
    const failure: unknown = await stopped.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(r.lifetime.stopped).toBe(true);
    expect(
      r.lifetime.isStoppedFailure(failure),
      'the preparation stopped at the leg own marker',
    ).toBe(true);
    expect(await settles(r.lifetime.finish())).toBe(true);
  });

  it('is refused by the registry once the invocation is terminating, and leaves no owner behind', () => {
    const f = invocationFixture();
    void f.registry.terminate({ kind: 'normal' });
    expect(
      () =>
        new HostedRunLifetime(
          { ...f.invocation, signalCustody: new SignalCustody() },
          homeView().view,
        ),
    ).toThrow(CliError);
    expect(f.registry.activeOwners).toBe(0);
  });
});
