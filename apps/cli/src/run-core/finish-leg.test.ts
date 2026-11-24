/**
 * The shared leg epilogue (MVP-8 step 3, increment 1): `finishLeg` is the departure, the exit code, the
 * retention passes and the takeover rules that `relavium run`, `relavium gate` and `relavium budget resume`
 * used to carry in two copies. The existing characterization suite pins the two commands through it; these
 * cases pin the function itself, so the Home's hosted run can call it as a third caller.
 *
 * The last block pins the one widened port of the increment: the resume core hands a host's secret reader the
 * run's masked slot names.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { RunHandle } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowLifetime } from '../commands/workflow-lifetime.js';
import { runCommand } from '../commands/run.js';
import { loadResolvedConfig } from '../config/load.js';
import { sweepCommittedEffects, type EffectNoticeOwner } from '../engine/effect-retention.js';
import type { sweepHostMediaBestEffort } from '../engine/media-gc.js';
import { inputDecision } from '../gate/decision.js';
import type { OpenedHistory } from '../history/open.js';
import { CliError, isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { createCliInvocation } from '../process/invocation.js';
import type { RemainingBudget } from '../process/invocation-registry.js';
import { captureIo } from '../test-support.js';
import { finishLeg, type FinishLegInput, type LegKind } from './finish-leg.js';
import { resumeRun } from './resume-run.js';
import { RunResources } from './run-resources.js';

let root: string;
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) =>
      actual.loadResolvedConfig({ ...options, home: root }),
  };
});
// The real sweep, spied: a test asks how often it ran and with what, and a paused run must never reach it.
vi.mock('../engine/effect-retention.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/effect-retention.js')>();
  return { ...actual, sweepCommittedEffects: vi.fn(actual.sweepCommittedEffects) };
});
const effectSweep = vi.mocked(sweepCommittedEffects);

let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-finish-leg-'));
  client = createClient(':memory:');
  runMigrations(client.db);
  effectSweep.mockClear();
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

const RUN_ID = 'run-finish-leg';
const CAS_ROOT = '/cas/finish-leg';
const GRACE_MS = 5_000;

type Durability = ReturnType<RunHandle['durability']>;
type Departure = Awaited<ReturnType<RunHandle['depart']>>;
type Outcome = FinishLegInput['outcome'];

const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

/**
 * A handle whose disposition is only readable AFTER the departure, as the real one is: before it the run's
 * durability still reads `durabilityBefore`, so a caller that reads early is told the wrong thing.
 */
function fakeHandle(
  options: {
    readonly departure?: Departure;
    readonly durability?: Durability;
    readonly durabilityBefore?: Durability;
    readonly terminalError?: ReturnType<RunHandle['terminalError']>;
  } = {},
): FinishLegInput['handle'] {
  let departed = false;
  const settled = options.durability ?? 'durable';
  return {
    depart: () => {
      departed = true;
      return Promise.resolve(options.departure ?? DETACHED);
    },
    durability: () => (departed ? settled : (options.durabilityBefore ?? settled)),
    terminalError: () => options.terminalError,
  };
}

const NOTICE_OWNER: EffectNoticeOwner = {
  signal: new AbortController().signal,
  assertAdmitting: () => undefined,
  failure: () => undefined,
  work: { retainWork: (factory) => factory() },
};

function budgetOf(remaining: number | undefined): RemainingBudget {
  return { deadline: () => 3_000, remainingMs: () => remaining };
}

function mediaSweepSpy(): ReturnType<typeof vi.fn<typeof sweepHostMediaBestEffort>> {
  return vi.fn<typeof sweepHostMediaBestEffort>(() => Promise.resolve(undefined));
}

interface Harness {
  readonly out: () => string;
  readonly err: () => string;
  readonly sweepMedia: ReturnType<typeof mediaSweepSpy>;
  readonly finish: () => Promise<number>;
}

function harness(
  leg: LegKind,
  outcome: Outcome,
  options: {
    readonly handle?: FinishLegInput['handle'];
    readonly db?: Db | undefined;
    readonly remainingMs?: number | undefined;
    readonly json?: boolean;
    readonly runId?: string;
    readonly noticeSurface?: FinishLegInput['noticeSurface'];
  } = {},
): Harness {
  const captured = captureIo();
  const sweepMedia = mediaSweepSpy();
  return {
    out: captured.out,
    err: captured.err,
    sweepMedia,
    finish: () =>
      finishLeg({
        leg,
        noticeSurface: options.noticeSurface ?? 'shell',
        runId: options.runId ?? RUN_ID,
        lifetime: {
          invocation: { registry: { budget: budgetOf(options.remainingMs) } },
          effectNoticeOwner: NOTICE_OWNER,
        },
        io: captured.io,
        json: options.json ?? false,
        handle: options.handle ?? fakeHandle(),
        outcome,
        db: 'db' in options ? options.db : client.db,
        mediaCasRoot: CAS_ROOT,
        mediaGcGraceMs: GRACE_MS,
        sweepMedia,
      }),
  };
}

async function refusalOf(call: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call();
  } catch (cause) {
    if (isCliError(cause)) return { code: cause.code, message: cause.message };
    throw cause;
  }
  throw new Error('the call was expected to refuse');
}

describe('finishLeg — the departure', () => {
  it.each<LegKind>(['start', 'resume'])(
    'a %s leg whose departure is not acknowledged refuses and sweeps nothing',
    async (leg) => {
      const run = harness(leg, 'completed', {
        handle: fakeHandle({ departure: { kind: 'continue' } }),
      });
      const refusal = await refusalOf(run.finish);
      expect(refusal).toEqual({
        code: 'internal',
        message: 'run departure was not acknowledged',
      });
      expect(effectSweep, 'no retention pass after a refused departure').not.toHaveBeenCalled();
      expect(run.sweepMedia).not.toHaveBeenCalled();
      expect(run.out() + run.err()).toBe('');
    },
  );

  it('reads the durability only after the departure has settled it', async () => {
    // Before the departure the disposition still reads durable; the departure is what finds it uncertain.
    const handle = fakeHandle({ durabilityBefore: 'durable', durability: 'uncertain' });
    const run = harness('start', 'completed', { handle });
    expect(await run.finish()).toBe(EXIT_CODES.durabilityUncertain);
  });
});

describe('finishLeg — the outcome decides the exit code', () => {
  it.each<readonly [Outcome, number]>([
    ['completed', EXIT_CODES.success],
    ['failed', EXIT_CODES.workflowFailed],
    ['cancelled', EXIT_CODES.workflowFailed],
    ['paused', EXIT_CODES.gatePaused],
    [undefined, EXIT_CODES.workflowFailed],
  ])('a start leg that ended %s exits %i', async (outcome, expected) => {
    expect(await harness('start', outcome).finish()).toBe(expected);
  });

  it.each<readonly [Outcome, number]>([
    ['completed', EXIT_CODES.success],
    ['failed', EXIT_CODES.workflowFailed],
    ['cancelled', EXIT_CODES.workflowFailed],
    ['paused', EXIT_CODES.gatePaused],
  ])('a resume leg that ended %s exits %i', async (outcome, expected) => {
    expect(await harness('resume', outcome).finish()).toBe(expected);
  });

  it('a delivered terminal whose durable write did not land outranks the outcome', async () => {
    const handle = fakeHandle({ durability: 'uncertain' });
    expect(await harness('start', 'completed', { handle }).finish()).toBe(
      EXIT_CODES.durabilityUncertain,
    );
    expect(await harness('resume', 'failed', { handle }).finish()).toBe(
      EXIT_CODES.durabilityUncertain,
    );
  });

  it('uncertain money and an effect that needs attention outrank the outcome', async () => {
    const money = fakeHandle({
      departure: { kind: 'detached', moneyDurability: 'uncertain', effectNeedsAttention: false },
    });
    expect(await harness('start', 'completed', { handle: money }).finish()).toBe(
      EXIT_CODES.moneyDurabilityUncertain,
    );
    const effect = fakeHandle({
      departure: { kind: 'closed', moneyDurability: 'durable', effectNeedsAttention: true },
    });
    expect(await harness('start', 'completed', { handle: effect }).finish()).toBe(
      EXIT_CODES.effectNeedsAttention,
    );
    const failed = fakeHandle({ terminalError: 'effect_needs_attention' });
    expect(await harness('resume', 'failed', { handle: failed }).finish()).toBe(
      EXIT_CODES.effectNeedsAttention,
    );
  });
});

describe('finishLeg — the retention passes', () => {
  it.each<LegKind>(['start', 'resume'])(
    'a terminal %s leg sweeps the effect journal and the media once each, for its own run',
    async (leg) => {
      const run = harness(leg, 'completed');
      expect(await run.finish()).toBe(EXIT_CODES.success);
      expect(effectSweep).toHaveBeenCalledTimes(1);
      expect(effectSweep).toHaveBeenCalledWith(expect.anything(), client.db, RUN_ID, NOTICE_OWNER);
      expect(run.sweepMedia).toHaveBeenCalledTimes(1);
      expect(run.sweepMedia).toHaveBeenCalledWith({
        db: client.db,
        casRoot: CAS_ROOT,
        currentRunId: RUN_ID,
        graceMs: GRACE_MS,
      });
    },
  );

  it.each<readonly [LegKind, Outcome]>([
    ['start', 'failed'],
    ['start', 'cancelled'],
    ['resume', 'failed'],
    ['resume', 'cancelled'],
  ])(
    'a %s leg that ended %s sweeps too: the run can no longer be resumed',
    async (leg, outcome) => {
      const run = harness(leg, outcome);
      await run.finish();
      expect(effectSweep).toHaveBeenCalledTimes(1);
      expect(run.sweepMedia).toHaveBeenCalledTimes(1);
    },
  );

  it.each<LegKind>(['start', 'resume'])(
    'a %s leg that is paused sweeps nothing: the run is resumable, so its rows and media must survive',
    async (leg) => {
      const run = harness(leg, 'paused');
      expect(await run.finish()).toBe(EXIT_CODES.gatePaused);
      expect(effectSweep, 'the effect journal of a paused run').not.toHaveBeenCalled();
      expect(run.sweepMedia, 'the media of a paused run').not.toHaveBeenCalled();
    },
  );

  it('starts no new maintenance after the original deadline', async () => {
    const run = harness('start', 'completed', { remainingMs: 0 });
    expect(await run.finish()).toBe(EXIT_CODES.success);
    expect(effectSweep).not.toHaveBeenCalled();
    expect(run.sweepMedia).not.toHaveBeenCalled();
  });

  it('has nothing to sweep on the in-memory path, which has no journal and no CAS', async () => {
    const run = harness('start', 'completed', { db: undefined });
    expect(await run.finish()).toBe(EXIT_CODES.success);
    expect(effectSweep).not.toHaveBeenCalled();
    expect(run.sweepMedia).not.toHaveBeenCalled();
  });
});

describe('finishLeg — a run another process took over', () => {
  /** A fenced run: a nonterminal outcome whose terminal could not be recorded. */
  const FENCED = (): FinishLegInput['handle'] => fakeHandle({ durability: 'uncertain' });

  it('a start leg says so on stderr and exits 6, with stdout untouched', async () => {
    const run = harness('start', 'paused', { handle: FENCED() });
    expect(await run.finish()).toBe(EXIT_CODES.runOwnedElsewhere);
    expect(run.err()).toBe(
      `run ${RUN_ID} was taken over by another process; this one stopped without recording an outcome — read \`relavium logs ${RUN_ID}\` for what actually happened\n`,
    );
    expect(run.out()).toBe('');
  });

  it('a start leg hosted in the TUI names the Home’s run browser, and no shell command (N2, MVP-11 OD-20)', async () => {
    const run = harness('start', 'paused', { handle: FENCED(), noticeSurface: 'tui' });
    expect(await run.finish()).toBe(EXIT_CODES.runOwnedElsewhere);
    expect(run.err()).toBe(
      `run ${RUN_ID} was taken over by another process; this one stopped without recording an outcome — read the run in /workflows (History tab) for what actually happened\n`,
    );
    expect(run.err()).not.toContain('relavium');
    expect(run.out()).toBe('');
  });

  it('a resume leg refuses with run_owned_elsewhere instead, and says nothing itself', async () => {
    const run = harness('resume', 'paused', { handle: FENCED() });
    const refusal = await refusalOf(run.finish);
    expect(refusal.code).toBe('run_owned_elsewhere');
    expect(refusal.message).toBe(
      `this process could not confirm ownership of run ${RUN_ID} during the resume and stopped — read \`relavium logs ${RUN_ID}\` for its real outcome, then retry if the gate is still pending`,
    );
    expect(run.out() + run.err()).toBe('');
  });

  describe('a run id that is not one plain word is never inside a command line (L6)', () => {
    const HOSTILE = [
      'x; rm -rf ~',
      '$(touch pwned)',
      '`touch pwned`',
      'a b',
      '--help',
      "x'y",
      'x|y',
      'x\ny',
    ];
    /** Every backticked run of text: the commands a person may copy. */
    const commandsOf = (text: string): string[] =>
      [...text.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? '');

    it.each(HOSTILE)(
      'id %j: a start leg`s stderr line offers only the bare command',
      async (id) => {
        const run = harness('start', 'paused', { handle: FENCED(), runId: id });
        expect(await run.finish()).toBe(EXIT_CODES.runOwnedElsewhere);
        expect(commandsOf(run.err())).toEqual(['relavium logs']);
        expect(run.out()).toBe('');
      },
    );

    it.each(HOSTILE)('id %j: a resume leg`s refusal offers only the bare command', async (id) => {
      const run = harness('resume', 'paused', { handle: FENCED(), runId: id });
      const refusal = await refusalOf(run.finish);
      expect(refusal.code).toBe('run_owned_elsewhere');
      expect(commandsOf(refusal.message)).toEqual(['relavium logs']);
    });

    it('an ordinary id reads exactly as it always did', async () => {
      const run = harness('start', 'paused', {
        handle: FENCED(),
        runId: 'a1b2c3d4-0000-4000-8000-000000000001',
      });
      await run.finish();
      expect(run.err()).toContain('`relavium logs a1b2c3d4-0000-4000-8000-000000000001`');
    });
  });

  it('a start leg that ended with no outcome and a fence also says so', async () => {
    const run = harness('start', undefined, { handle: FENCED() });
    expect(await run.finish()).toBe(EXIT_CODES.runOwnedElsewhere);
    expect(run.err()).toContain('was taken over by another process');
  });
});

describe('finishLeg — a resume that finds the run already settled', () => {
  it('is a clean no-op on stdout, with no sweep', async () => {
    const run = harness('resume', undefined);
    expect(await run.finish()).toBe(EXIT_CODES.success);
    expect(run.out()).toBe(`run ${RUN_ID} already settled; nothing to resume\n`);
    expect(run.err()).toBe('');
    expect(effectSweep).not.toHaveBeenCalled();
    expect(run.sweepMedia).not.toHaveBeenCalled();
  });

  it('under --json says it on stderr so stdout stays a pure event stream', async () => {
    const run = harness('resume', undefined, { json: true });
    expect(await run.finish()).toBe(EXIT_CODES.success);
    expect(run.out()).toBe('');
    expect(run.err()).toBe(`run ${RUN_ID} already settled; nothing to resume\n`);
  });

  it('is a start leg’s failure, not a no-op: a run with no outcome did not settle', async () => {
    const run = harness('start', undefined);
    expect(await run.finish()).toBe(EXIT_CODES.workflowFailed);
    expect(run.out() + run.err()).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------
// The widened resume port: the context a host's secret reader receives carries the masked slot names.
// ---------------------------------------------------------------------------------------------------------

/** A run parked at an `input` gate that holds two masked `secret` slots. */
const TWO_SECRETS_AT_A_GATE = `schema_version: '1.0'
workflow:
  id: finish-leg-two-secrets
  inputs:
    - { name: api_key, type: secret }
    - { name: token, type: secret }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

function openDurable(
  workflow: Parameters<NonNullable<Parameters<typeof runCommand>[1]['openRunStore']>>[0],
): OpenedHistory {
  return {
    store: createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: workflow.workflow.id,
        name: workflow.workflow.id,
        definitionJson: JSON.stringify(workflow),
      },
    }),
    db: client.db,
    terminalOutboxPath: join(root, 'outbox.ndjson'),
    close: () => undefined,
  };
}

describe('the resume port hands a host the masked slot names', () => {
  it('names every masked slot of the parked run, frozen', async () => {
    const path = join(root, 'two-secrets.relavium.yaml');
    writeFileSync(path, TWO_SECRETS_AT_A_GATE);
    const parked = captureIo();
    await runCommand(
      { workflow: path, input: [], allowMcpStdio: [], secretInputsStdin: true },
      {
        io: { ...parked.io, stdin: Readable.from(['api_key=first-value\ntoken=second-value\n']) },
        invocation: createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
        global: {
          json: false,
          color: false,
          cwd: root,
          configPath: undefined,
          verbosity: 'normal',
        },
        openRunStore: openDurable,
      },
    );
    const row = client.sqlite.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 1').get();
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string')
      throw new Error('no run was recorded');
    const runId = row.id;

    const io = captureIo().io;
    const lifetime = new WorkflowLifetime(
      createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
      io,
    );
    const resources = new RunResources(lifetime, io);
    const { config, homeDir } = loadResolvedConfig({ cwd: root, configPath: undefined });
    let seen: { readonly maskedSlots: readonly string[] } | undefined;
    const refusal = await refusalOf(() =>
      lifetime.execute(async () => {
        try {
          await resumeRun(
            { runId, kind: 'human', secretStdin: true, decision: inputDecision({}) },
            { io, noticeSurface: 'shell', global: { cwd: root } },
            { config, homeDir },
            {
              openDb: () => ({ db: client.db, close: () => undefined }),
              secretInputs: (context) => {
                seen = context;
                // The reader's answer is not under test: stop the resume as soon as the context is captured.
                throw new CliError('invalid_invocation', 'context captured');
              },
              consentGate: () => () => Promise.resolve(new Map()),
            },
            lifetime,
            resources,
          );
          return EXIT_CODES.success;
        } finally {
          await resources.releaseMcp();
          resources.closeHistoryDb();
        }
      }),
    );
    expect(refusal.message).toBe('context captured');
    expect([...(seen?.maskedSlots ?? [])].sort()).toEqual(['api_key', 'token']);
    expect(
      Object.isFrozen(seen?.maskedSlots),
      'a port cannot change what its answer is checked against',
    ).toBe(true);
  });
});
