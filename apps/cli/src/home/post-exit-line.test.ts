/**
 * What the Home prints once its screen is restored, about a hosted run
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6): "if the Home then exits, it prints one
 * plain line after the screen is restored naming the run id and the shell remedy".
 *
 * Two layers. `RunHost.exitFacts()` says WHAT is owed, from real legs over real run cores (a safety fact is a leg whose departure carries
 * it; an ordinary outcome owes nothing). `driveHome` says WHEN and HOW it is printed: after the terminal controls are restored, once per
 * fact, never for a run that ended in an ordinary way, and with the shared database left open under a leg the host had to abandon.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { RunDurability, RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome, type HomeDeps, type OnboardingTerminalLifecycle } from './drive-home.js';
import { RunHost, type HostedExitFact, type HostedLegEnd } from './run-host.js';

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: host-exit-line
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

type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

interface Leg {
  readonly departure?: Departure;
  readonly durability?: RunDurability;
}

function completedHandle(runId: string, leg: Leg): RunHandle {
  const event: RunEvent = {
    runId,
    timestamp: '2026-11-23T00:00:00.000Z',
    sequenceNumber: 1,
    type: 'run:completed',
    outputs: {},
    totalTokensUsed: { input: 0, output: 0 },
    totalCostMicrocents: 0,
    durationMs: 1,
  };
  return {
    runId,
    events: (async function* (): AsyncGenerator<RunEvent> {
      await Promise.resolve();
      yield event;
    })(),
    subscribe: () => () => undefined,
    cancel: () => undefined,
    depart: () => Promise.resolve(leg.departure ?? DETACHED),
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => leg.durability ?? 'durable',
    terminalError: () => undefined,
  };
}

let root: string;
let operatorHome: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-post-exit-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'relavium-post-exit-home-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(operatorHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A real host over the in-memory `history.db`, whose one leg runs `handle` (the workflow only has to resolve and parse). */
function hostOver(handle: RunHandle) {
  const f = invocationFixture();
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
      vi.spyOn(engine, 'start').mockReturnValue(handle);
      return Promise.resolve(engine);
    },
    sweepMedia: () => Promise.resolve(undefined),
  });
  const path = join(root, 'exit-line.relavium.yaml');
  writeFileSync(path, WORKFLOW);
  const run = async (): Promise<HostedLegEnd> => {
    const launch = await host.start({ workflow: path, rawInputs: { n: '3' } });
    if (launch.kind !== 'started') throw new Error(`expected a started leg, got ${launch.kind}`);
    return launch.ended;
  };
  return { host, f, run };
}

describe('what the Home owes after a hosted run (RunHost.exitFacts)', () => {
  it.each([
    {
      code: 8,
      leg: { departure: { ...DETACHED, moneyDurability: 'uncertain' } } satisfies Leg,
      says: 'required money receipts',
    },
    {
      code: 7,
      leg: { departure: { ...DETACHED, effectNeedsAttention: true } } satisfies Leg,
      says: 'an external effect needs attention',
    },
    {
      code: 5,
      leg: { durability: 'uncertain' } satisfies Leg,
      says: 'its record may not have been written',
    },
  ])('exit $code: one fact, naming the run and the shell remedy', async ({ leg, says }) => {
    const r = hostOver(completedHandle('run-safety-1', leg));
    const end = await r.run();
    expect(end.terminal.safety).toBeDefined();
    const facts = r.host.exitFacts();
    expect(facts).toHaveLength(1);
    const [fact] = facts;
    expect(fact?.kind).toBe('safety');
    expect(fact?.runId).toBe('run-safety-1');
    expect(fact?.line).toContain('run-safety-1');
    expect(fact?.line).toContain(says);
    expect(fact?.line, 'the shell remedy is in the line').toMatch(
      /`relavium (logs|status) run-safety-1`/,
    );
    expect(fact?.line, 'one plain line').not.toContain('\n');
  });

  it('a completed run owes nothing', async () => {
    const r = hostOver(completedHandle('run-fine', {}));
    const end = await r.run();
    expect(end.terminal.disposition).toBe('completed');
    expect(r.host.exitFacts()).toEqual([]);
  });

  it('keeps the most serious safety fact, not the last one, when a later leg ends in an ordinary way', async () => {
    let n = 0;
    const handles = [
      completedHandle('run-uncertain', { departure: { ...DETACHED, effectNeedsAttention: true } }),
      completedHandle('run-fine-after', {}),
    ];
    const f = invocationFixture();
    const host = new RunHost({
      invocation: f.invocation,
      io: captureIo().io,
      global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
      db: client.db,
      homeDir: operatorHome,
      buildEngine: () => {
        const handle = handles[n++];
        if (handle === undefined) throw new Error('no handle');
        const engine = new WorkflowEngine({
          host: createInMemoryHost(),
          executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
        });
        vi.spyOn(engine, 'start').mockReturnValue(handle);
        return Promise.resolve(engine);
      },
      sweepMedia: () => Promise.resolve(undefined),
    });
    const path = join(root, 'two.relavium.yaml');
    writeFileSync(path, WORKFLOW);
    for (let i = 0; i < 2; i += 1) {
      const launch = await host.start({ workflow: path, rawInputs: { n: '3' } });
      if (launch.kind !== 'started') throw new Error('not started');
      await launch.ended;
    }
    const facts = host.exitFacts();
    expect(facts.map((fact) => fact.runId)).toEqual(['run-uncertain']);
  });
});

describe('driveHome prints the line once the screen is restored', () => {
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

  /** The Home over an injected mount (no TTY), recording the order of what reached the terminal and what closed. */
  function mountHome(run: RunHost) {
    const order: string[] = [];
    const out: string[] = [];
    const closeSpy = vi.fn(() => {
      order.push('db:close');
    });
    const opened: OpenedSessionStore = {
      store: createSessionStore(client.db),
      db: client.db,
      close: closeSpy,
    };
    const io: CliIo = {
      writeOut: (text) => {
        order.push('line');
        out.push(text);
      },
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
          unmount: () => {
            order.push('unmount');
            acknowledgeExit();
          },
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
      writeControl: (sequence) => {
        if (sequence.includes(SHOW_CURSOR)) order.push('screen restored');
      },
      exit: () => undefined,
      onboardingPrompter: {
        intro: () => undefined,
        outro: () => undefined,
        note: () => undefined,
        select: () => Promise.resolve(Symbol('cancel')),
        password: () => Promise.resolve(Symbol('cancel')),
        isCancel: (v): v is symbol => typeof v === 'symbol',
      },
      run,
    };
    const running = driveHome(deps);
    const leave = async (): Promise<number> => {
      await vi.waitFor(() => expect(captured).toBeDefined());
      const props = captured;
      if (props === undefined) throw new Error('Home not mounted');
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms
      return running;
    };
    return { leave, order, out, closeSpy };
  }

  function idleHost(): RunHost {
    return new RunHost({
      invocation: invocationFixture().invocation,
      io: captureIo().io,
      global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
      db: client.db,
      homeDir: operatorHome,
    });
  }

  it('prints exactly one plain line for a safety fact, naming the run id, after the controls are restored', async () => {
    const run = idleHost();
    const fact: HostedExitFact = {
      kind: 'safety',
      runId: 'run-0007',
      line: 'Run run-0007: an external effect needs attention. Do not retry; read `relavium logs run-0007`.',
    };
    vi.spyOn(run, 'exitFacts').mockReturnValue([fact]);
    const home = mountHome(run);
    expect(await home.leave()).toBe(0);
    expect(home.out, 'one line, newline-terminated, naming the run').toEqual([`${fact.line}\n`]);
    expect(home.out[0]).toContain('run-0007');
    expect(home.order.indexOf('screen restored'), 'the controls were restored first').toBeLessThan(
      home.order.indexOf('line'),
    );
    expect(home.order.indexOf('unmount')).toBeLessThan(home.order.indexOf('line'));
  });

  it('prints one line per fact, and nothing else', async () => {
    const run = idleHost();
    const facts: HostedExitFact[] = [
      { kind: 'safety', runId: 'run-a', line: 'Run run-a: an external effect needs attention.' },
      {
        kind: 'abandoned',
        runId: 'run-b',
        line: 'Run run-b was still stopping when the Home left.',
      },
    ];
    vi.spyOn(run, 'exitFacts').mockReturnValue(facts);
    const home = mountHome(run);
    await home.leave();
    expect(home.out).toEqual(facts.map((fact) => `${fact.line}\n`));
  });

  it('prints nothing extra when the hosted run ended in an ordinary way', async () => {
    const r = hostOver(completedHandle('run-ordinary', {}));
    expect((await r.run()).terminal.disposition).toBe('completed');
    expect(r.host.exitFacts()).toEqual([]);
    const home = mountHome(r.host);
    expect(await home.leave()).toBe(0);
    expect(home.out, 'no line at all: the screen already said how it ended').toEqual([]);
  });

  it('prints nothing for a Home that never hosted a run', async () => {
    const home = mountHome(idleHost());
    await home.leave();
    expect(home.out).toEqual([]);
  });

  it('closes the shared database after a leg that settled, and leaves it open under one the host abandoned', async () => {
    const settled = mountHome(idleHost());
    await settled.leave();
    expect(
      settled.closeSpy,
      'the usual order: the host is joined, then the database closes',
    ).toHaveBeenCalledOnce();

    const run = idleHost();
    vi.spyOn(run, 'abandoned', 'get').mockReturnValue(true);
    const home = mountHome(run);
    expect(await home.leave()).toBe(0);
    expect(
      home.closeSpy,
      'the abandoned leg may still be writing: the handle is left to the process`s exit',
    ).not.toHaveBeenCalled();
  });
});
