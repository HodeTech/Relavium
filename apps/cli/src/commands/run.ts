import type { CliInvocation } from '../process/invocation.js';
import type { defaultSubscribeSignals } from '../process/signals.js';
import { warnTeardown } from '../process/close-quietly.js';
import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import type { RendererCreationOwner } from './workflow-terminal.js';
import { WorkflowLifetime } from './workflow-lifetime.js';
import { EgressWorkScope } from '../engine/egress-work.js';
import { randomUUID } from 'node:crypto';

import {
  type EffectCorrelation,
  parseWorkflow,
  resolveAndValidateWorkflowInputs,
  type WorkflowDefinition,
  type WorkflowEngine,
  WorkflowParseError,
} from '@relavium/core';
import type { MediaBilledModality } from '@relavium/shared';

import { warnSnapshotLiterals } from '../authoring/snapshot-notice.js';
import { loadResolvedConfig } from '../config/load.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { onceEffortNotice, unpricedModelNote } from '../chat/effort-notice.js';
import {
  createEffectJournalPort,
  createEffectJournalStore,
  createEffectResumePort,
  createRunLeasePort,
} from '@relavium/db';

import { sweepCommittedEffects } from '../engine/effect-retention.js';
import { createCliHost } from '../engine/host.js';
import {
  connectWorkflowMcp,
  type StdioConsentGate,
  surfaceMcpSkipped,
  type WorkflowMcpRuntime,
} from '../engine/mcp-servers.js';
import {
  sweepHostMediaBestEffort as defaultSweepMedia,
  sweepMediaAtTerminal,
} from '../engine/media-gc.js';
import { buildMediaEngineWiring } from '../engine/media-wiring.js';
import { readUserPricingOverlay } from '../engine/pricing-overlay.js';
import {
  createProviderResolver,
  neededProviderIds,
  type ProviderResolver,
} from '../engine/providers.js';
import type { GatePrompter } from '../gate/prompter.js';
import { selectGatePrompter } from '../gate/select-prompter.js';
import type { OpenedHistory } from '../history/open.js';
import { createConsentGate } from '../engine/mcp-consent-gate.js';
import { createBoundConsentPrompter } from '../mcp/consent-prompt.js';
import { CliError } from '../process/errors.js';
import { storageBoundaryError } from '../process/owned-storage.js';
import { sourceLabel } from '../process/source-label.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { parseSecretLines } from '../secrets/parse-secret-lines.js';
import { readSecretFromStdin, type StdinSecretContext } from '../secrets/read-secret.js';
import { resolveWorkflowSource } from '../workflows/resolve.js';
import {
  assertWorkflowCatalogValid,
  driveRun,
  isTerminalOutcome,
  outcomeToExitCode,
} from './drive.js';
import {
  assertOrdinaryInputsAllowed,
  inputAdmissionMessage,
  parseInputArgs,
  resolveInputs,
} from './inputs.js';

export interface RunCommandArgs {
  readonly workflow: string;
  readonly input: readonly string[];
  /** Read declared secret inputs once from bounded, non-TTY stdin (ADR-0107). */
  readonly secretInputsStdin?: boolean;
  /**
   * `--allow-mcp-stdio <digest>`, repeatable
   * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §6).
   *
   * Authorizes a stdio MCP server for THIS invocation and writes no grant: a flag is how a CI definition
   * states its own trust, and a shared runner that silently accumulated grants would slowly agree to
   * everything anyone ran on it. The digest is a hash of an approved declaration, not a secret — safe in a
   * pipeline definition, a script, or a log.
   */
  readonly allowMcpStdio: readonly string[];
}

export interface RunCommandDeps {
  /** The original bootstrap invocation; native authority stays host-only. */
  readonly invocation?: CliInvocation;
  /** Host-owned subscription, injectable without installing ambient OS listeners in retained-owner tests. */
  readonly subscribeSignals?: typeof defaultSubscribeSignals;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable so tests (and the 2.K harness) drive a stub provider + the in-memory host. */
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  /** Injectable provider seam (key pre-flight + the engine's resolver). Defaults to the env resolver. */
  readonly providers?: ProviderResolver;
  /** Construct key/provider services only after complete pure input admission. */
  readonly resolveKeys?: () => {
    readonly providers: ProviderResolver;
    readonly mcpSecretResolver: McpSecretResolver;
  };
  /** Narrow fixture seam; production uses the shared bounded stdin reader. */
  readonly readSecretInput?: () => Promise<string>;
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
  readonly selectRenderer?: (
    io: CliIo,
    global: GlobalOptions,
    creation?: RendererCreationOwner,
  ) => RunRenderer;
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
  readonly startMcpClient?: typeof import('@relavium/mcp').startMcpClient;
  /** Injectable consent gate (ADR-0084 §1) — a fixture supplies one that never prompts. */
  readonly consentGate?: StdioConsentGate;
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
/**
 * Parse the workflow, turning an authored fault into the surface's typed exit-2 invocation error.
 *
 * A `WorkflowParseError` is the author's problem and reads as one; anything else is a bug in the engine and
 * rethrows verbatim rather than being relabelled as an invalid invocation.
 */
function parseOrRefuse(yaml: string, source: string): WorkflowDefinition {
  try {
    return parseWorkflow(yaml, { source });
  } catch (err) {
    if (err instanceof WorkflowParseError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }
}

export async function runCommand(args: RunCommandArgs, deps: RunCommandDeps): Promise<ExitCode> {
  const lifetime = new WorkflowLifetime(deps.invocation, deps.io, deps.subscribeSignals);
  return lifetime.execute(() => runOwned(args, deps, lifetime));
}

async function runOwned(
  args: RunCommandArgs,
  deps: RunCommandDeps,
  lifetime: WorkflowLifetime,
): Promise<ExitCode> {
  const nativeProcesses = nativeProcessesForInvocation(lifetime.invocation);
  lifetime.checkpoint();
  if ((deps.global.allowFsRoots?.length ?? 0) > 0) {
    throw new CliError(
      'invalid_invocation',
      '--allow-fs-root applies only to Home, chat, chat-resume and agent run.',
    );
  }
  const build = deps.buildEngine ?? defaultBuildEngine;
  // Syntax faults do not need even configuration or workflow reads.
  const rawInputs = parseInputArgs(args.input);

  // Config (2.B) — a malformed layer surfaces as exit 2; the project dir powers id/slug discovery,
  // homeDir locates `~/.relavium/history.db` (2.H).
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });

  const source = resolveWorkflowSource(args.workflow, { cwd: deps.global.cwd, projectConfigDir });

  const def = parseOrRefuse(source.yaml, sourceLabel(deps.global.cwd, source.path));
  assertOrdinaryInputsAllowed(def, rawInputs);
  const secretInputs = await readRunSecrets(args, deps, def, lifetime);
  lifetime.checkpoint();
  const admitted = resolveAndValidateWorkflowInputs(
    def,
    resolveInputs(def, rawInputs, secretInputs),
  );
  if (!admitted.ok) {
    // Core owns every value contract; raw names were refused above. Never attach caller payload/cause.
    throw new CliError('invalid_invocation', inputAdmissionMessage(admitted.issues));
  }
  const inputs = admitted.inputs;
  warnSnapshotLiterals(def, deps.io);
  lifetime.checkpoint();
  const keys = deps.resolveKeys?.();
  lifetime.checkpoint();
  // Preserve injected precedence, sharing the admitted run's resolver with provider preflight.
  const providers = deps.providers ?? keys?.providers ?? createProviderResolver(deps.io.env);
  const mayPrompt = args.secretInputsStdin !== true;
  const promptIo = mayPrompt ? deps.io : { ...deps.io, stdinIsTty: false };

  // Pre-flight provider keys: surface a missing key for an inline agent's PRIMARY provider as a clean
  // exit-2 invocation error (with the RELAVIUM_<PROVIDER>_API_KEY hint) BEFORE the engine starts, rather
  // than letting it surface mid-run as run:failed (exit 1) with the hint possibly lost. Scoped to keys
  // that are guaranteed needed (see neededProviderIds): a fallback-chain or `$ref` agent's key is
  // conditional and still surfaces at runtime, so the pre-flight never false-fails a valid run. The key
  // is read only to confirm presence here — never logged, stored, or rendered.
  for (const id of neededProviderIds(def)) {
    lifetime.checkpoint();
    providers.keyFor(id);
  }

  // Declared here, assigned AFTER the MCP connect below — the shared `finally` closes both resources, and
  // the store cannot be opened until the definition it must freeze is known.
  let opened: OpenedHistory | undefined;
  let mcpRuntime: WorkflowMcpRuntime | undefined;
  let mcpAcknowledged = true;
  const reportMcpCloseFailure = (_serverId: string, cause: unknown): void => {
    mcpAcknowledged = false;
    lifetime.cleanupFailed(cause);
    warnTeardown(deps.io, 'MCP');
  };
  const mcpWork = new EgressWorkScope();
  try {
    // Inbound MCP (2.R Step 3b): aggregate the `mcp_servers` declared by the workflow's INLINE agents, start
    // them fail-loud (a connect/discovery failure is an exit-2 CliError, cause stripped), and rewrite the
    // workflow so each inline agent's grant includes ONLY its own servers' discovered tools. `undefined` ⇒ no
    // inline agent declared a server. The spawned children are torn down at the run terminal (the finally).
    mcpRuntime = await connectWorkflowMcp(def, {
      ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
      cwd: deps.global.cwd,
      connectSignal: lifetime.signal,
      assertAdmitting: () => lifetime.checkpoint(),
      onFailure: (cause) => {
        if (!lifetime.isStoppedFailure(cause)) lifetime.failure(cause);
      },
      onCloseError: reportMcpCloseFailure,
      budget: lifetime.invocation.registry.budget,
      work: mcpWork,
      resolveSecret:
        deps.mcpSecretResolver ?? keys?.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env),
      registrations: config.mcpServers,
      // The file that declared them, for the prompt — the imported-artifact case naming its own file (§7).
      artifact: source.path,
      // **Consent before any spawn** (ADR-0084 §1). Injectable so a fixture drives it without a terminal;
      // the default is the real gate, so an un-wired test path is a decision rather than an accident.
      consentGate:
        deps.consentGate ??
        createConsentGate({
          io: promptIo,
          global: deps.global,
          homeDir,
          allowedDigests: args.allowMcpStdio,
          signal: lifetime.signal,
          prompt: mayPrompt
            ? (subject, options) => {
                const prompt = createBoundConsentPrompter(promptIo);
                return lifetime.terminal.runPrompt(() => prompt(subject, options));
              }
            : undefined,
        }),
      ...(deps.startMcpClient === undefined ? {} : { startMcpClient: deps.startMcpClient }),
    });
    lifetime.checkpoint();
    if (mcpRuntime !== undefined) surfaceMcpSkipped(deps.io, mcpRuntime.client.skipped);
    const runWorkflow = mcpRuntime?.workflow ?? def;

    // Durable history (2.H): open `~/.relavium/history.db` and run THIS workflow on a host backed by the
    // SQLite `RunStore`, so every node-boundary/terminal event is persisted before delivery (ADR-0036).
    // Tests and the 2.K harness omit `openRunStore` → the in-memory default host, no DB touched. `close()`
    // releases the connection at run end (the shared `finally`). A persist failure rejects out of the engine
    // (ADR-0050 fatal posture).
    //
    // **Opened with `runWorkflow`, and opened HERE, after the MCP connect** (ADR-0083 §5). The store freezes
    // its argument into `runs.workflow_definition_snapshot` — the graph a resume rebuilds the run from — and
    // this used to be handed `def`, the PRE-augmentation workflow, while the engine below started on the
    // augmented one. On every workflow with `mcp_servers` the two differed, so the durable record of "the
    // exact graph that ran" recorded a graph that did not run. MCP-discovered tool grants are part of
    // workflow identity: a server that returns a different tool set on resume IS a divergence, and it can
    // only be seen if what was frozen is what was executed.
    lifetime.checkpoint();
    try {
      opened = deps.openRunStore?.(runWorkflow, homeDir, deps.global.cwd);
    } catch (err) {
      // Classify only this open operation; engine/work faults retain their own boundary.
      throw storageBoundaryError(err);
    }

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
      ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
      workspaceDir: deps.global.cwd,
      fsScopeTier: config.fsScope ?? 'sandboxed',
    };
    // ADR-0071 §6: an authored `reasoning_effort` the bound model does not accept is WITHHELD — and reported. To
    // STDERR, never stdout: `--json` owns stdout, and a warning line in the middle of the machine-readable stream
    // would be a parse error for whatever is consuming the run. Silence was the alternative, and it is worse: the
    // run succeeds, the knob does nothing, and the bill arrives at the provider's default tier.
    // `onceEffortNotice`: the gate is consulted on EVERY agent-node execution, so an agent inside a `loop` would
    // otherwise print the same warning on every iteration. A withheld tier is a standing condition, not an event.
    const onEffortWithheld = onceEffortNotice((note: string): void =>
      deps.io.writeErr(`warning: ${note}\n`),
    );
    // ADR-0071 §K7: a turn ran on a model we could not price, so `budget.max_cost_microcents` did not apply. The
    // governor already dedups per model. STDERR, never stdout (`--json`). `budget.strict_cost_cap` blocks instead.
    const onUnpriced = (
      model: string,
      capMicrocents: number,
      modalities?: readonly MediaBilledModality[],
    ): void =>
      deps.io.writeErr(
        `warning: ${unpricedModelNote(model, capMicrocents, 'budget.strict_cost_cap', modalities)}\n`,
      );
    let engineOptions: BuildEngineOptions = {
      providers,
      toolEnv,
      onEffortWithheld,
      onUnpriced,
      ...mcpOption,
    };
    let mediaCasRoot: string | undefined;
    if (opened !== undefined) {
      // Bound to a `const` so the closures below keep the narrowing: `opened` is a `let` assigned inside
      // this same try, and TypeScript cannot prove it is still set by the time a callback runs.
      const history = opened;
      const wiring = buildMediaEngineWiring(history.db, homeDir, deps.global.cwd, config, (m) =>
        deps.io.writeErr(`${m}\n`),
      );
      mediaCasRoot = wiring.media.casRoot; // hoisted for the run-end host media GC below
      // D15 load-check (ADR-0044 §2 / ADR-0045 §1): an incapable / malformed-generative authored `output_modalities`
      // fails fast at LOAD (exit 2), not only at the runtime FallbackChain pre-skip. `gate` runs the SAME check
      // (drive.ts), so a fresh run and a resume reject consistently.
      // Validated against `def`, not `runWorkflow`, and that is still correct: MCP augmentation rewrites only
      // each inline agent's `tools` grant, which this check does not read — so the verdict is identical
      // either way. Said here because the sentence that used to carry it covered the store too, and the store
      // moved to `runWorkflow` a few lines up.
      assertWorkflowCatalogValid(def, wiring.workflowModelCatalog);
      // The ADR-0065 §2 user-pricing overlay (2.5.G S10), read from the SAME durable `history.db` — so a
      // workflow using a user-priced model is enforced by `budget.max_cost_microcents` (pre-egress) + priced in
      // realized cost (the agent node). Only wired on this durable-history branch: the in-memory unit/harness
      // path has no db, hence no user rows. An empty map (no user rows) is harmless (fills nothing). Non-fatal:
      // a corrupt provider/catalog row degrades to an empty overlay, never failing the run over a pricing read.
      const resolvePrice = readUserPricingOverlay(history.db);
      engineOptions = {
        providers,
        toolEnv,
        onEffortWithheld,
        onUnpriced,
        // The durable effect journal (ADR-0080), built per node from the run correlation the engine supplies.
        // A FACTORY because the correlation differs per node and per retry attempt, and only the run loop
        // knows both — the same reason the realized-cost ledger is threaded this way.
        effectJournal: (correlation: EffectCorrelation) =>
          createEffectJournalPort(
            createEffectJournalStore(history.db, { uuid: randomUUID, now: Date.now }),
            correlation,
            { providerAttempt: 1, toolCallId: 'run' },
          ),
        // …and its READ half. `relavium run` reaches the gate through its own budget-approval resume, so a
        // write-only wiring here would record effects it could never enforce.
        effectResume: createEffectResumePort(
          createEffectJournalStore(history.db, { uuid: randomUUID, now: Date.now }),
        ),
        host: createCliHost(history.store, {
          media: wiring.media,
          // ADR-0078 §4: a terminal the store refuses is held in a SEPARATE FILE beside history.db. Wiring
          // the real path here is what makes the guarantee exist on the shipping surface — the in-memory
          // reference the host defaults to survives nothing, which is fatal in a one-shot CLI process.
          terminalOutboxPath: history.terminalOutboxPath,
          // ADR-0079: the DURABLE lease, built from the same store the run persists to — the in-memory
          // reference the host defaults to guards nothing across processes, which is the whole point here.
          runLeases: createRunLeasePort(history.store),
        }),
        resolveMediaSurface: wiring.resolveMediaSurface,
        ...(wiring.maxTokensEstimate === undefined
          ? {}
          : { maxTokensEstimate: wiring.maxTokensEstimate }),
        ...(wiring.mediaCostEstimate === undefined
          ? {}
          : { mediaCostEstimate: wiring.mediaCostEstimate }),
        ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
        ...mcpOption,
      };
    }
    lifetime.checkpoint();
    const engine = await build(engineOptions);
    lifetime.adoptEngine(engine);
    lifetime.checkpoint();
    // **Drain the terminal outbox before starting (ADR-0078 §4/§5).** A prior process may have produced a
    // terminal its store would not take; it is held in `~/.relavium/terminal-outbox.ndjson` and this is
    // "the next `relavium` start" that the `durabilityUncertain` exit code tells the user to wait for. Draining
    // rather than `reconcile()`: this writes only terminals the engine itself already produced, for runs whose
    // log still lacks one, and switches on nothing else. Best-effort — a run that cannot start because an
    // unrelated run's terminal could not be retried would be the wrong trade.
    await engine.drainTerminalOutbox().catch(() => undefined);
    // The AUGMENTED workflow — the same one the store froze above, so the durable snapshot and the executed
    // graph are one thing rather than two that happen to be close.
    // `toolGrantsFinal`: the MCP servers were connected and the workflow rewritten above, so every inline
    // agent's `tools` already includes what its servers discovered. That makes the plan-build narrowing
    // check correct here (ADR-0094) — a node listing a tool its agent lacks is refused before the run id
    // exists, rather than partway through, after upstream nodes have spent money.
    lifetime.checkpoint();
    const handle = engine.start({
      workflow: runWorkflow,
      eventConsumption: 'iterated',
      inputs,
      planOptions: { toolGrantsFinal: true },
    });

    lifetime.adoptHandle(handle);

    // Hand the live run and the already-registered command lifetime to the shared driver (2.G). It owns
    // the primary event loop and the reserved renderer lifecycle (output mode per
    // commands.md "Output modes": ink TUI on a TTY, NDJSON under --json, plain otherwise), and the inline
    // human-gate prompt when an interactive prompter is present (CI / --json / no-TTY → no prompter → a gate
    // pause exits 3, resumable by `relavium gate`).
    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: (creation) =>
        (deps.selectRenderer ?? selectRenderer)(deps.io, deps.global, creation),
      makeGatePrompter: () =>
        mayPrompt
          ? (deps.selectGatePrompter ?? selectGatePrompter)(deps.io, deps.global)
          : undefined,
      io: deps.io,
      json: deps.global.json,
    });

    const departure = await handle.depart();
    if (departure.kind === 'continue')
      throw new CliError('internal', 'run departure was not acknowledged');
    const exitCode = outcomeToExitCode(
      outcome,
      handle.durability(),
      handle.terminalError(),
      departure,
      false,
    );

    // Host media GC (2.S/D-GC, ADR-0042 §4) — best-effort, keyed on a TERMINAL outcome: the clean-terminal reclaim
    // retry + the grace-window byte reclaim + the CAS-orphan sweep, over the same durable `history.db`. Skipped on
    // a `paused` outcome (resumable — its media must survive) and the in-memory path (no CAS). See
    // sweepMediaAtTerminal for the guard + the never-fail-the-run swallow.
    // Retention (effect-journal.md §9). A terminal run can no longer be resumed — `resumeFromCheckpoint`
    // returns a closed handle for one — so its COMMITTED rows have no reader left and go. Unresolved rows
    // are untouched by construction: they are the record an operator needs, and an exit-7 run's rows must
    // survive precisely because its run is over.
    // `opened` is undefined on the in-memory path (`--no-history`), which has no journal to sweep.
    if (isTerminalOutcome(outcome) && opened !== undefined) {
      sweepCommittedEffects(deps.io, opened.db, handle.runId);
    }
    await sweepMediaAtTerminal({
      sweep: deps.sweepMedia ?? defaultSweepMedia,
      isTerminal: isTerminalOutcome(outcome),
      db: opened?.db,
      casRoot: mediaCasRoot,
      currentRunId: handle.runId,
      graceMs: config.mediaGcGraceMs,
    });

    // The handle's disposition OUTRANKS the outcome (ADR-0078 §5): a delivered `run:completed` whose
    // durable write did not land must not exit 0, or a script is told the run is recorded when it is not.
    // Off the HANDLE, not a `subscribe()` — see the note in `gate.ts`. `start()`'s ordering happens to be
    // safe for a subscriber, but the two surfaces must not answer this differently.
    // **Say what happened.** A fenced run writes no terminal by design (ADR-0079 §5), so the renderer's
    // final summary falls through to a bare "run ended" and the user is left with an exit code and no
    // explanation of why their run stopped. `relavium gate` already explains this case; `relavium run`
    // hitting the same takeover deserves the same sentence. stderr, so `--json` stdout stays a clean stream.
    if (exitCode === EXIT_CODES.runOwnedElsewhere) {
      deps.io.writeErr(
        `run ${handle.runId} was taken over by another process; this one stopped without recording an outcome — read \`relavium logs ${handle.runId}\` for what actually happened\n`,
      );
    }
    return exitCode;
  } catch (cause) {
    // Record before an entered MCP/DB cleanup tail can hold the rejection from execute().
    if (!lifetime.isStoppedFailure(cause)) lifetime.failure(cause);
    throw cause;
  } finally {
    // Cleanup is joined directly, never via a registry promise that depends on this finally.
    // Neither cancellation nor a deadline certifies the engine/MCP/DB or terminal released.
    try {
      await mcpRuntime?.client.close(reportMcpCloseFailure);
    } catch (cause) {
      mcpAcknowledged = false;
      lifetime.cleanupFailed(cause);
      warnTeardown(deps.io, 'MCP');
    }
    mcpWork.seal();
    try {
      await mcpWork.done;
    } catch (cause) {
      mcpAcknowledged = false;
      lifetime.cleanupFailed(cause);
    }
    if (!mcpAcknowledged) await new Promise<never>(() => {});
    try {
      opened?.close();
    } catch (cause) {
      lifetime.cleanupFailed(storageBoundaryError(cause));
      warnTeardown(deps.io, 'history database');
    }
  }
}

/** A fixed context: neither the workflow argument nor a pasted line belongs in a secret diagnostic. */
const RUN_SECRET_STDIN_CONTEXT: StdinSecretContext = {
  pipeHint:
    'pipe NAME=value secret inputs on stdin to relavium run <workflow> --secret-inputs-stdin; secret inputs are never arguments.',
  emptyMessage:
    'no secret inputs were read from stdin for run --secret-inputs-stdin (empty input).',
};

async function readRunSecrets(
  args: RunCommandArgs,
  deps: RunCommandDeps,
  def: WorkflowDefinition,
  lifetime: WorkflowLifetime,
): Promise<Readonly<Record<string, string>>> {
  if (!args.secretInputsStdin) return {};
  if (!(def.workflow.inputs ?? []).some((decl) => decl.type === 'secret')) {
    throw new CliError(
      'invalid_invocation',
      '--secret-inputs-stdin requires a declared secret input.',
    );
  }
  const raw = await (deps.readSecretInput?.() ?? readSecretFromStdin(RUN_SECRET_STDIN_CONTEXT));
  lifetime.checkpoint();
  return parseSecretLines(raw, 'run --secret-inputs-stdin');
}
