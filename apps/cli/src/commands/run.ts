import { relative } from 'node:path';

import {
  WorkflowParseError,
  parseWorkflow,
  type WorkflowDefinition,
  type WorkflowEngine,
} from '@relavium/core';
import type { McpClient, McpServerConfig } from '@relavium/mcp';

import { loadResolvedConfig } from '../config/load.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import {
  connectWorkflowMcp,
  surfaceMcpSkipped,
  type WorkflowMcpRuntime,
} from '../engine/mcp-servers.js';
import {
  sweepHostMediaBestEffort as defaultSweepMedia,
  sweepMediaAtTerminal,
} from '../engine/media-gc.js';
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
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
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
  readonly openRunStore?: (
    workflow: WorkflowDefinition,
    homeDir: string,
    projectRoot: string,
  ) => OpenedHistory;
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
  /**
   * Injectable MCP connect-all (2.R Step 3b) — tests pass a fake that never spawns a child; production uses the
   * real `@relavium/mcp` `startMcpClient`. Threads through to {@link connectWorkflowMcp}.
   */
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
  /** The MCP named-secret resolver (2.R Step 4) — production injects the keychain-backed one; default env-only. */
  readonly mcpSecretResolver?: McpSecretResolver;
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
    opened = deps.openRunStore?.(def, homeDir, deps.global.cwd);
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
  let mcpRuntime: WorkflowMcpRuntime | undefined;
  try {
    // Inbound MCP (2.R Step 3b): aggregate the `mcp_servers` declared by the workflow's INLINE agents, start
    // them fail-loud (a connect/discovery failure is an exit-2 CliError, cause stripped), and rewrite the
    // workflow so each inline agent's grant includes ONLY its own servers' discovered tools. `undefined` ⇒ no
    // inline agent declared a server. The spawned children are torn down at the run terminal (the finally).
    mcpRuntime = await connectWorkflowMcp(def, {
      cwd: deps.global.cwd,
      resolveSecret: deps.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env),
      registrations: config.mcpServers,
      ...(deps.startMcpClient === undefined ? {} : { startMcpClient: deps.startMcpClient }),
    });
    if (mcpRuntime !== undefined) surfaceMcpSkipped(deps.io, mcpRuntime.client.skipped);
    const runWorkflow = mcpRuntime?.workflow ?? def;
    const mcpOption =
      mcpRuntime === undefined
        ? {}
        : {
            mcp: {
              toolDefs: mcpRuntime.client.toolDefs,
              capability: mcpRuntime.client.capability,
            },
          };

    // Media host-wiring (2.S): when durable history is open, the SAME `~/.relavium/history.db` connection
    // backs the `model_catalog` reader (→ `resolveMediaSurface` routing) + the `media_references` retention
    // junction, and the host gets the global CAS root (`~/.relavium/media/`) + the project-relative `save_to`
    // root (`.relavium/runs/`). Absent (the in-memory unit/harness path) ⇒ no media ports, so a media-producing
    // run fails loud — never a silent leak. The per-modality `media_cost_estimate` default folds in from config.
    // 2.5.A (ADR-0055): wire the read+write fs + process ToolHost arms, jailed to the launch cwd at the
    // resolved `[defaults].fs_scope` (default sandboxed). The factory feeds BOTH this run path and the chat
    // path, so a workflow's read_file / write_file / run_command / git_status work (the MCP arm merges on top).
    const toolEnv = {
      workspaceDir: deps.global.cwd,
      fsScopeTier: config.fsScope ?? 'sandboxed',
    };
    let engineOptions: BuildEngineOptions = { providers, toolEnv, ...mcpOption };
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
        toolEnv,
        host: createCliHost(opened.store, { media: wiring.media }),
        resolveMediaSurface: wiring.resolveMediaSurface,
        ...(wiring.mediaCostEstimate === undefined
          ? {}
          : { mediaCostEstimate: wiring.mediaCostEstimate }),
        ...mcpOption,
      };
    }
    const engine = await build(engineOptions);
    // Run the AUGMENTED workflow (each inline agent's grant unioned with its MCP tool ids); the catalog/store
    // were validated against the original, which is identical except for those `tools` grants.
    const handle = engine.start({ workflow: runWorkflow, inputs });

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

    // Host media GC (2.S/D-GC, ADR-0042 §4) — best-effort, keyed on a TERMINAL outcome: the clean-terminal reclaim
    // retry + the grace-window byte reclaim + the CAS-orphan sweep, over the same durable `history.db`. Skipped on
    // a `paused` outcome (resumable — its media must survive) and the in-memory path (no CAS). See
    // sweepMediaAtTerminal for the guard + the never-fail-the-run swallow.
    await sweepMediaAtTerminal({
      sweep: deps.sweepMedia ?? defaultSweepMedia,
      isTerminal: isTerminalOutcome(outcome),
      db: opened?.db,
      casRoot: mediaCasRoot,
      currentRunId: handle.runId,
      graceMs: config.mediaGcGraceMs,
    });

    return outcomeToExitCode(outcome);
  } finally {
    // Guarantee the MCP teardown runs EVEN IF the db close throws — a nested finally so neither resource leaks.
    // Present only when an inline agent declared a server; idempotent. A teardown error must never mask the run
    // outcome (closeAll swallows per-connection; the db close is best-effort here too).
    try {
      opened?.close();
    } finally {
      await mcpRuntime?.client.close();
    }
  }
}
