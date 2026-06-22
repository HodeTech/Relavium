import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { runCommand } from '../commands/run.js';
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
 * Deferred (scope-split in phase-2-cli.md §2.K): the gate-RESUME scenario (`relavium gate --approve` →
 * completion) needs 2.G + 2.H; agent fixtures via recorded-LLM replay and the nightly live-provider lane
 * need the replay-provider wiring. This first cut covers the non-agent scenarios + run-to-gate.
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
});
