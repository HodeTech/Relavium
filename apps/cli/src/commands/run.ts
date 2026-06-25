import { relative } from 'node:path';

import {
  WorkflowParseError,
  parseWorkflow,
  type WorkflowDefinition,
  type WorkflowEngine,
} from '@relavium/core';

import { loadResolvedConfig } from '../config/load.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { sweepHostMediaBestEffort as defaultSweepMedia } from '../engine/media-gc.js';
import { buildMediaEngineWiring } from '../engine/media-wiring.js';
import {
  createProviderResolver,
  neededProviderIds,
  type ProviderResolver,
} from '../engine/providers.js';
import type { GatePrompter } from '../gate/prompter.js';
import { selectGatePrompter } from '../gate/select-prompter.js';
import type { OpenedHistory } from '../history/open.js';
import { CliError } from '../process/errors.js';
import { type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
import { resolveWorkflowSource } from '../workflows/resolve.js';
import {
  assertWorkflowCatalogValid,
  driveRun,
  isTerminalOutcome,
  outcomeToExitCode,
} from './drive.js';
import { parseInputArgs, resolveInputs } from './inputs.js';

export interface RunCommandArgs {
  readonly workflow: string;
  readonly input: readonly string[];
}

export interface RunCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable so tests (and the 2.K harness) drive a stub provider + the in-memory host. */
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  /** Injectable provider seam (key pre-flight + the engine's resolver). Defaults to the env resolver. */
  readonly providers?: ProviderResolver;
  /**
   * Production wires the durable SQLite run-history store (2.H) here, per workflow; the unit tests and the
   * 2.K harness omit it, keeping the in-memory `RunStore` so they never open `~/.relavium/history.db`.
   */
  readonly openRunStore?: (workflow: WorkflowDefinition, homeDir: string) => OpenedHistory;
  /**
   * Injectable renderer selector (TUI / json / plain). Defaults to the real {@link selectRenderer}; tests
   * inject a fake renderer (onEvent + finalize spies) to assert the finalize wiring without a TTY.
   */
  readonly selectRenderer?: (io: CliIo, global: GlobalOptions) => RunRenderer;
  /**
   * Injectable interactive gate-prompter selector (2.G). Defaults to the real {@link selectGatePrompter}
   * (present only on an interactive TTY); tests inject a fake prompter to drive the inline gate-resolve path
   * without a TTY, or omit it so a gate pause exits 3 like the non-interactive path.
   */
  readonly selectGatePrompter?: (io: CliIo, global: GlobalOptions) => GatePrompter | undefined;
  /**
   * Injectable run-end host media GC (2.S/D-GC); defaults to {@link defaultSweepMedia}. Tests spy on it to
   * assert the run-end invocation without touching a real CAS, and the in-memory unit path never reaches it.
   */
  readonly sweepMedia?: typeof defaultSweepMedia;
}

/**
 * The `relavium run` core (2.D) — the M3 keystone and first real consumer of `@relavium/core`:
 * resolve + parse the workflow, coerce/validate `--input`, build the engine, then hand the live run to the
 * shared {@link driveRun} core (event stream → renderer, SIGINT → cooperative cancel, interactive human gate →
 * inline prompt, 2.G) and map the terminal outcome to a deterministic exit code
 * ([commands.md](../../../docs/reference/cli/commands.md#exit-codes)). Framework-free — no commander/ink import.
 * Pre-run faults (config / not-found / bad input / parse) throw a typed {@link CliError} (exit 2); run-time
 * outcomes arrive as events and map to 0/1/3.
 */
export async function runCommand(args: RunCommandArgs, deps: RunCommandDeps): Promise<ExitCode> {
  const build = deps.buildEngine ?? defaultBuildEngine;
  // One resolver shared by the key pre-flight and the engine, reading the CLI's env seam (io.env).
  const providers = deps.providers ?? createProviderResolver(deps.io.env);

  // Config (2.B) — a malformed layer surfaces as exit 2; the project dir powers id/slug discovery,
  // homeDir locates `~/.relavium/history.db` (2.H).
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });

  const source = resolveWorkflowSource(args.workflow, { cwd: deps.global.cwd, projectConfigDir });

  let def: WorkflowDefinition;
  try {
    def = parseWorkflow(source.yaml, { source: relative(deps.global.cwd, source.path) });
  } catch (err) {
    if (err instanceof WorkflowParseError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }

  const inputs = resolveInputs(def, parseInputArgs(args.input));

  // Pre-flight provider keys: surface a missing key for an inline agent's PRIMARY provider as a clean
  // exit-2 invocation error (with the RELAVIUM_<PROVIDER>_API_KEY hint) BEFORE the engine starts, rather
  // than letting it surface mid-run as run:failed (exit 1) with the hint possibly lost. Scoped to keys
  // that are guaranteed needed (see neededProviderIds): a fallback-chain or `$ref` agent's key is
  // conditional and still surfaces at runtime, so the pre-flight never false-fails a valid run. The key
  // is read only to confirm presence here — never logged, stored, or rendered.
  for (const id of neededProviderIds(def)) {
    providers.keyFor(id);
  }

  // Durable history (2.H): open `~/.relavium/history.db` and run THIS workflow on a host backed by the
  // SQLite `RunStore`, so every node-boundary/terminal event is persisted before delivery (ADR-0036). Tests
  // and the 2.K harness omit `openRunStore` → the in-memory default host, no DB touched. `close()` releases
  // the connection at run end. A persist failure rejects out of the engine (ADR-0050 fatal posture).
  let opened: OpenedHistory | undefined;
  try {
    opened = deps.openRunStore?.(def, homeDir);
  } catch (err) {
    // A pre-run history fault (cannot create / open / migrate ~/.relavium/history.db) is an INVOCATION
    // fault (exit 2), not a workflow failure (exit 1) — surface it as such, before the engine starts, so a
    // `--json`/CI consumer can tell "the history db couldn't open" from "a node failed mid-run".
    throw new CliError(
      'invalid_invocation',
      `could not open the run history database: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  try {
    // Media host-wiring (2.S): when durable history is open, the SAME `~/.relavium/history.db` connection
    // backs the `model_catalog` reader (→ `resolveMediaSurface` routing) + the `media_references` retention
    // junction, and the host gets the global CAS root (`~/.relavium/media/`) + the project-relative `save_to`
    // root (`.relavium/runs/`). Absent (the in-memory unit/harness path) ⇒ no media ports, so a media-producing
    // run fails loud — never a silent leak. The per-modality `media_cost_estimate` default folds in from config.
    let engineOptions: BuildEngineOptions = { providers };
    let mediaCasRoot: string | undefined;
    if (opened !== undefined) {
      const wiring = buildMediaEngineWiring(opened.db, homeDir, deps.global.cwd, config, (m) =>
        deps.io.writeErr(`${m}\n`),
      );
      mediaCasRoot = wiring.media.casRoot; // hoisted for the run-end host media GC below
      // D15 load-check (ADR-0044 §2 / ADR-0045 §1): an incapable / malformed-generative authored `output_modalities`
      // fails fast at LOAD (exit 2), not only at the runtime FallbackChain pre-skip. `gate` runs the SAME check
      // (drive.ts), so a fresh run and a resume reject consistently.
      assertWorkflowCatalogValid(def, wiring.workflowModelCatalog);
      engineOptions = {
        providers,
        host: createCliHost(opened.store, { media: wiring.media }),
        resolveMediaSurface: wiring.resolveMediaSurface,
        ...(wiring.mediaCostEstimate === undefined
          ? {}
          : { mediaCostEstimate: wiring.mediaCostEstimate }),
      };
    }
    const engine = await build(engineOptions);
    const handle = engine.start({ workflow: def, inputs });

    // Hand the live run to the shared driver (2.G): it owns the event loop, the SIGINT cooperative-cancel
    // contract, the renderer lifecycle (constructed inside, after SIGINT registration — output mode per
    // commands.md "Output modes": ink TUI on a TTY, NDJSON under --json, plain otherwise), and the inline
    // human-gate prompt when an interactive prompter is present (CI / --json / no-TTY → no prompter → a gate
    // pause exits 3, resumable by `relavium gate`).
    const outcome = await driveRun({
      engine,
      handle,
      makeRenderer: () => (deps.selectRenderer ?? selectRenderer)(deps.io, deps.global),
      gatePrompter: (deps.selectGatePrompter ?? selectGatePrompter)(deps.io, deps.global),
      io: deps.io,
    });

    // Host media GC (2.S/D-GC, ADR-0042 §4) — a best-effort pass keyed on the run reaching a TERMINAL event: the
    // clean-terminal reclaim retry (a crash-dropped prior sweep) + the grace-window byte reclaim + the CAS-orphan
    // sweep, over the same durable `history.db`. Swallows any throw (never a run-correctness break). Skipped on a
    // `paused` outcome (the run is resumable — its media must survive) and on the in-memory unit/harness path.
    if (opened !== undefined && mediaCasRoot !== undefined && isTerminalOutcome(outcome)) {
      try {
        await (deps.sweepMedia ?? defaultSweepMedia)({
          db: opened.db,
          casRoot: mediaCasRoot,
          currentRunId: handle.runId,
        });
      } catch {
        // Defense-in-depth: the default sweeper already swallows, but the run-end GC must NEVER fail the run —
        // a throwing sweeper (a test, or a future impl) is swallowed here too (ADR-0042 §3).
      }
    }

    return outcomeToExitCode(outcome);
  } finally {
    opened?.close();
  }
}
