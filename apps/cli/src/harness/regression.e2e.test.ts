import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkflowDefinition } from '@relavium/core';
import { createClient, createRunHistoryStore, runMigrations } from '@relavium/db';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateCommand } from '../commands/gate.js';
import { runCommand } from '../commands/run.js';
import { resolveHomeDir } from '../config/load.js';
import type { OpenedHistory } from '../history/open.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { run } from '../run.js';
import { captureIo } from '../test-support.js';

/**
 * The 2.K engine regression harness — the CLI adopted as the engine's canonical end-to-end test gate.
 * Each fixture under ./fixtures/ is a committed `.relavium.yaml` run through the REAL `relavium run`
 * path (`runCommand` → the default engine: the standard node executor + expression sandbox over the
 * real `createCliHost`) in `--json` mode, and the resulting NDJSON stream + exit code are asserted
 * against a pinned expectation. The fixtures are non-agent, so runs are fully deterministic and offline
 * (no LLM, no provider key, no network) on every PR — the per-PR regression gate phase-2-cli.md §2.K
 * requires. See [docs/reference/cli/regression-harness.md](../../../../docs/reference/cli/regression-harness.md).
 *
 * Each event is reduced to a `type:nodeId` SIGNATURE (so the assertion is keyed by node, not just by
 * event type — a wrong-branch / wrong-node regression is caught, not only a dropped/extra event). For a
 * deterministic fixture the exact signature ORDER is asserted; the `fan-out` fixture is `parallel`, whose
 * branch events legitimately interleave by async (sandbox) completion timing, so it asserts the signature
 * MULTISET + the stable anchors (`run:started` first, the last-emitted event last, gap-free
 * `sequenceNumber`) instead. `runId`/`timestamp`/cost/duration are per-run and never asserted.
 *
 * The per-fixture cases enter at the `runCommand` boundary (the engine-fidelity entry point); a final
 * case re-runs one fixture through the full `run(argv)` CLI shell (argv → commander → terminal exit code)
 * and asserts the IDENTICAL stream + exit code, proving the argv-parsing glue wires a real workflow run
 * faithfully — coverage `run.test.ts` leaves out (it drives the shell only for meta-ops + faults).
 *
 * The gate-RESUME scenario (`relavium gate --approve` → completion) — deferred in the §2.K first cut because
 * it needs 2.G + 2.H — lands HERE now (the final `it` below): the `human-gate` fixture runs to exit `3`
 * against a durable (in-memory) history db, then a fresh-process `gate` reloads + resumes it to `run:completed`.
 * Still deferred: agent fixtures via recorded-LLM replay and the nightly live-provider lane (need the
 * replay-provider wiring).
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

interface Scenario {
  readonly file: string;
  readonly input: readonly string[];
  readonly exit: ExitCode;
  /** Expected `type:nodeId` signatures (a node-bearing event is `type:nodeId`, otherwise just `type`). */
  readonly events: readonly string[];
  /** A `parallel` node interleaves its branch events by async timing → assert the multiset, not the order. */
  readonly parallel?: boolean;
  /**
   * For a `parallel` fixture: happens-before pairs `[earlier, later]` that must hold *despite* the
   * legitimate branch interleave — the causal spine a pure multiset cannot see (most importantly the
   * fan-in barrier: the merge starts only after every branch completes).
   */
  readonly causalOrder?: readonly (readonly [string, string])[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    file: 'sequential.relavium.yaml',
    input: ['n=3'],
    exit: EXIT_CODES.success,
    events: [
      'run:started',
      'node:started:start',
      'node:completed:start',
      'node:started:double',
      'node:completed:double',
      'node:started:out',
      'node:completed:out',
      'run:completed',
    ],
  },
  {
    file: 'fan-out.relavium.yaml',
    input: ['n=3'],
    exit: EXIT_CODES.success,
    parallel: true,
    events: [
      'run:started',
      'node:started:start',
      'node:completed:start',
      'node:started:fan',
      'node:completed:fan',
      'node:started:double',
      'node:started:triple',
      'node:completed:double',
      'node:completed:triple',
      'node:started:combine',
      'node:completed:combine',
      'node:started:out',
      'node:completed:out',
      'run:completed',
    ],
    causalOrder: [
      // fan-out: the parallel node dispatches both branches.
      ['node:started:fan', 'node:started:double'],
      ['node:started:fan', 'node:started:triple'],
      // each branch completes after it starts (only double↔triple may interleave).
      ['node:started:double', 'node:completed:double'],
      ['node:started:triple', 'node:completed:triple'],
      // fan-in barrier: the merge starts only after BOTH branches complete (a multiset can't catch this).
      ['node:completed:double', 'node:started:combine'],
      ['node:completed:triple', 'node:started:combine'],
      // the merged result feeds the output.
      ['node:completed:combine', 'node:started:out'],
    ],
  },
  {
    // n < 10 → the `lo` branch runs, `hi` is skip-propagated.
    file: 'conditional.relavium.yaml',
    input: ['n=3'],
    exit: EXIT_CODES.success,
    events: [
      'run:started',
      'node:started:start',
      'node:completed:start',
      'node:started:check',
      'node:completed:check',
      'node:skipped:hi',
      'node:started:lo',
      'node:completed:lo',
      'node:started:out',
      'node:completed:out',
      'run:completed',
    ],
  },
  {
    // n >= 10 → the OTHER branch: `hi` runs, `lo` is skip-propagated (proves both arms + symmetric skip).
    file: 'conditional.relavium.yaml',
    input: ['n=15'],
    exit: EXIT_CODES.success,
    events: [
      'run:started',
      'node:started:start',
      'node:completed:start',
      'node:started:check',
      'node:completed:check',
      'node:skipped:lo',
      'node:started:hi',
      'node:completed:hi',
      'node:started:out',
      'node:completed:out',
      'run:completed',
    ],
  },
  {
    file: 'human-gate.relavium.yaml',
    input: [],
    exit: EXIT_CODES.gatePaused,
    events: [
      'run:started',
      'node:started:start',
      'node:completed:start',
      'node:started:gate',
      'human_gate:paused:gate',
      'run:paused', // not the run's logical terminal (run:paused is non-terminal) — the last event before exit 3
    ],
  },
  {
    file: 'failure.relavium.yaml',
    input: [],
    exit: EXIT_CODES.workflowFailed,
    events: [
      'run:started',
      'node:started:start',
      'node:completed:start',
      'node:started:boom',
      'node:failed:boom',
      'node:skipped:out', // the downstream output is unreachable once `boom` fails
      'run:failed',
    ],
  },
];

function signature(event: RunEvent): string {
  return 'nodeId' in event ? `${event.type}:${String(event.nodeId)}` : event.type;
}

function globalOptions(): GlobalOptions {
  return {
    json: true,
    color: false,
    cwd: FIXTURES_DIR,
    configPath: undefined,
    verbosity: 'normal',
  };
}

/**
 * Parse captured stdout as the `--json` NDJSON stream: every line round-trips to EXACTLY one
 * canonical `RunEvent` (`RunEventSchema.parse(line)` deep-equals the raw line, so a stray field is
 * caught) — round-trip equality, not mere parse-success.
 */
function parseEvents(stdout: string): RunEvent[] {
  const trimmed = stdout.trimEnd();
  // An empty stream → []: a missing-output regression then fails the signature diff (empty vs expected)
  // rather than crashing in `JSON.parse('')` with a cryptic "Unexpected end of JSON input".
  if (trimmed === '') return [];
  return trimmed.split('\n').map((line) => {
    const raw: unknown = JSON.parse(line);
    const event = RunEventSchema.parse(raw);
    expect(event).toEqual(raw);
    return event;
  });
}

/** Run one fixture through `relavium run … --json`, returning per-node signatures + raw events + exit. */
async function runFixture(
  scenario: Scenario,
): Promise<{ sigs: string[]; events: RunEvent[]; code: ExitCode }> {
  const { io, out, err } = captureIo();
  const code = await runCommand(
    { workflow: join(FIXTURES_DIR, scenario.file), input: [...scenario.input] },
    { io, global: globalOptions() },
  );
  expect(err()).toBe(''); // a clean offline run writes nothing to stderr (stdout-pure contract, ADR-0049)
  const events = parseEvents(out());
  return { sigs: events.map(signature), events, code };
}

/** `sequenceNumber` must be exactly 0..n-1 — the bus's gap-free, exactly-once guarantee (ADR-0036). */
function assertGapFreeSeq(events: readonly RunEvent[]): void {
  expect(events.map((e) => e.sequenceNumber)).toEqual(events.map((_, index) => index));
}

/** Build a full process-style argv (`node relavium …`) exactly as `run()` is entered in production. */
const argv = (...tokens: string[]): string[] => ['node', 'relavium', ...tokens];

describe('engine regression harness (2.K) — offline fixtures over `relavium run … --json`', () => {
  // ISOLATE `~/.relavium` FOR THE WHOLE SUITE (deferred-tasks.md, 2026-07-13). The full-shell `run(argv)` case
  // below drives the REAL CLI shell, which resolves the DEFAULT history db (`~/.relavium/history.db`) and RUNS
  // MIGRATIONS against it — the developer's actual chat history under a real HOME. Point HOME at a throwaway dir
  // for every test (a floor, so a future test cannot silently re-acquire the real path either), and GUARD it: if
  // the redirect ever fails to take, refuse to run rather than migrate real user data (a suite that writes to real
  // data both damages it and blinds CI, which is exactly how this was found — PR #75).
  const realHome = homedir();
  let isolatedHome: string | undefined;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), 'relavium-harness-home-'));
    prevHome = process.env['HOME'];
    prevProfile = process.env['USERPROFILE'];
    process.env['HOME'] = isolatedHome;
    process.env['USERPROFILE'] = isolatedHome; // Windows home
    if (resolveHomeDir({}) === realHome) {
      throw new Error(
        'e2e isolation failed: HOME still resolves to the real home — refusing to run migrations against ~/.relavium.',
      );
    }
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = prevProfile;
    if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true });
    isolatedHome = undefined;
  });

  for (const scenario of SCENARIOS) {
    const label = `${scenario.file} [${scenario.input.join(' ') || 'no input'}] → exit ${String(scenario.exit)}`;
    it(label, async () => {
      const { sigs, events, code } = await runFixture(scenario);
      expect(code).toBe(scenario.exit);
      assertGapFreeSeq(events);
      if (scenario.parallel === true) {
        // Branch events interleave by async timing → assert the multiset + the stable anchors.
        expect(sigs[0]).toBe('run:started');
        expect(sigs.at(-1)).toBe(scenario.events.at(-1));
        expect([...sigs].sort()).toEqual([...scenario.events].sort());
        // Beyond the multiset: the causal (happens-before) spine must still hold despite the interleave —
        // notably the fan-in barrier. (`indexOf` is safe here: the multiset check above already proved
        // every signature is present, so each lookup is ≥ 0.)
        for (const [earlier, later] of scenario.causalOrder ?? []) {
          expect(sigs.indexOf(earlier)).toBeLessThan(sigs.indexOf(later));
        }
      } else {
        // Fully deterministic → assert the exact ordered per-node signature sequence.
        expect(sigs).toEqual([...scenario.events]);
      }
    });
  }

  // The per-fixture loop above enters at the `runCommand` boundary (the engine-fidelity entry point).
  // This scenario instead drives a fixture through the full `run(argv)` CLI shell —
  // argv → extractGlobalOptions → commander → the `run <workflow>` subcommand action → runCommand →
  // terminal exit code — and asserts it yields the IDENTICAL NDJSON + exit code the harness pins. It
  // proves the argv-parsing shell wires a real workflow run faithfully (the positional `<workflow>`, the
  // repeatable `--input`, the position-independent `--json` global), closing the gap that `run.test.ts`
  // leaves: that suite exercises the shell only for meta-ops (`--help`/`--version`) and faults (exit 2),
  // never a real run reaching a terminal exit (0/1/3).
  //
  // It uses the conditional fixture at n=15 ON PURPOSE — that is the only arm whose topology proves
  // `--input` actually threaded. A missing/mis-parsed `--input` makes `inputs.n >= 10` false, routing to
  // `lo` (the no-input default), which flips `node:skipped:hi`↔`node:skipped:lo` and fails the
  // assertion. A topology-flat fixture (e.g. sequential, whose `inputs.n * 2` yields NaN — not an error —
  // when n is absent) would pass even if the shell dropped `--input`; and n=3 also routes to `lo`, so it
  // could not distinguish a dropped flag from a threaded one. n=15 (→ `hi`) is the one that gives the
  // `--input` assertion real teeth.
  it('drives a real run through the full `run(argv)` CLI shell with the identical result', async () => {
    const inputDependent = SCENARIOS.find(
      (s) => s.file === 'conditional.relavium.yaml' && s.input.includes('n=15'),
    );
    if (inputDependent === undefined) {
      throw new Error('the conditional n=15 fixture is missing from SCENARIOS');
    }

    const { io, out, err } = captureIo();
    const code = await run(
      argv(
        'run',
        join(FIXTURES_DIR, inputDependent.file),
        '--input',
        ...inputDependent.input,
        '--json',
      ),
      io,
    );

    expect(code).toBe(inputDependent.exit); // exit code propagates argv → run subcommand → runCommand → run()
    expect(err()).toBe(''); // the stdout-pure contract holds through the full shell too (ADR-0049)
    const events = parseEvents(out());
    assertGapFreeSeq(events);
    // The `hi` arm (node:skipped:lo, node:started:hi) is reachable only if `--input n=15` threaded; a
    // dropped flag would route to `lo` and mismatch here — that is what makes this an `--input` test.
    expect(events.map(signature)).toEqual([...inputDependent.events]);
  });

  // The gate-RESUME scenario (deferred in the §2.K first cut; lands with 2.G): run the human-gate fixture to
  // the gate-paused exit `3` against a DURABLE history db, then resume it from a FRESH process via the `gate`
  // command — the cross-process path (reload snapshot + reconstruct checkpoint + resumeFromCheckpoint) — and
  // assert it drives to `run:completed`. This closes 2.K's deferred half over the same offline fixtures.
  it('resumes a gate-paused run via `relavium gate --approve` to completion (closes 2.K’s deferred half)', async () => {
    // A real FILE db (not `:memory:`) so the gate leg opens a genuinely SEPARATE connection — exercising the
    // reopen/reload a fresh-process `relavium gate` does, not a shared in-memory handle.
    const dir = mkdtempSync(join(tmpdir(), 'relavium-harness-'));
    const dbPath = join(dir, 'history.db');
    const runClient = createClient(dbPath);
    runMigrations(runClient.db);
    try {
      // Persist the run so a fresh connection's `gate` can reload it (the durable substrate 2.H gives 2.G).
      const openRunStore = (workflow: WorkflowDefinition): OpenedHistory => ({
        store: createRunHistoryStore(runClient.db, {
          uuid: () => randomUUID(),
          now: () => Date.now(),
          workflow: {
            slug: workflow.workflow.id,
            name: workflow.workflow.name ?? workflow.workflow.id,
            definitionJson: JSON.stringify(workflow),
          },
        }),
        db: runClient.db,
        close: () => {},
      });

      // 1. Run to the gate → exit 3, persisted to the FILE.
      const runIo = captureIo();
      const runCode = await runCommand(
        { workflow: join(FIXTURES_DIR, 'human-gate.relavium.yaml'), input: [] },
        { io: runIo.io, global: globalOptions(), openRunStore },
      );
      expect(runCode).toBe(EXIT_CODES.gatePaused);
      const preEvents = parseEvents(runIo.out());
      const runId = preEvents.find((e) => e.type === 'run:started')?.runId;
      if (runId === undefined) {
        throw new Error('expected a run:started event carrying the runId');
      }
      // Close the run's connection — the resume runs against a brand-new connection to the same file.
      runClient.sqlite.close();

      // 2. Resume over a FRESH connection (a separate `gate` process reopening the file) → exit 0, to completion.
      const gateClient = createClient(dbPath);
      runMigrations(gateClient.db); // idempotent — mirrors openLocalDb's migrate-on-open
      const gateIo = captureIo();
      try {
        const gateCode = await gateCommand(
          { runId, approve: true },
          {
            io: gateIo.io,
            global: globalOptions(),
            openDb: () => ({ db: gateClient.db, close: () => {} }),
          },
        );
        expect(gateCode).toBe(EXIT_CODES.success);
        expect(gateIo.err()).toBe(''); // the resume stream is stdout-pure NDJSON too (ADR-0049)
        const resumed = parseEvents(gateIo.out());
        // The resume emits exactly the continuation: the gate resolves, then the downstream output, then done.
        expect(resumed.map(signature)).toEqual([
          'human_gate:resumed:gate',
          'node:started:out',
          'node:completed:out',
          'run:completed',
        ]);
        // 2.G's headline invariant: the resumed stream continues the seq counter GAP-FREE from the pre-resume
        // max (lastSequenceNumber + 1), proving the cross-process counter was reseeded — not restarted at 0.
        const lastPreSeq = Math.max(...preEvents.map((e) => e.sequenceNumber));
        const resumedSeqs = resumed.map((e) => e.sequenceNumber);
        expect(resumedSeqs).toEqual(resumedSeqs.map((_, i) => lastPreSeq + 1 + i));
      } finally {
        gateClient.sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
