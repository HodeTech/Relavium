import { randomUUID } from 'node:crypto';

import {
  type EffectCorrelation,
  parseWorkflow,
  resolveAndValidateWorkflowInputs,
  type RunHandle,
  type WorkflowDefinition,
  type WorkflowEngine,
  WorkflowParseError,
} from '@relavium/core';
import {
  createEffectJournalPort,
  createEffectJournalStore,
  createEffectResumePort,
  createRunLeasePort,
} from '@relavium/db';
import type { MediaBilledModality } from '@relavium/shared';

import { warnSnapshotLiterals } from '../authoring/snapshot-notice.js';
import { onceEffortNotice, unpricedModelNote } from '../chat/effort-notice.js';
import {
  assertOrdinaryInputsAllowed,
  inputAdmissionMessage,
  resolveInputs,
} from '../commands/inputs.js';
import { assertWorkflowCatalogValid, assertWorkflowToolArmsWired } from '../commands/drive.js';
import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { loadResolvedConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/resolve.js';
import {
  buildEngine as defaultBuildEngine,
  RUN_TOOL_PROFILE,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import {
  connectWorkflowMcp,
  type StdioConsentGate,
  surfaceMcpSkipped,
} from '../engine/mcp-servers.js';
import { buildMediaEngineWiring } from '../engine/media-wiring.js';
import { readUserPricingOverlay } from '../engine/pricing-overlay.js';
import {
  createProviderResolver,
  neededProviderIds,
  type ProviderResolver,
} from '../engine/providers.js';
import { unwiredToolArms } from '../engine/tool-host/assemble.js';
import type { OpenedHistory } from '../history/open.js';
import { acquireNativeResource } from '../process/acquire-native-resource.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import type { GlobalOptions } from '../process/options.js';
import { storageBoundaryError } from '../process/owned-storage.js';
import { sourceLabel } from '../process/source-label.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { resolveWorkflowSource } from '../workflows/resolve.js';
import type { RunResources } from './run-resources.js';
import type { RunLifetime } from './run-lifetime.js';
import { assertWorkflowSourceDigest } from './source-digest.js';

/** What a second `PreparedRun.start()` says: a host bug, so fixed text that names the misuse and carries no stored value. */
export const PREPARED_RUN_REUSED =
  'a PreparedRun was reused: its start ran twice; prepare one run for each start';

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

/**
 * What a start says when the project's file scope is not the one the person confirmed. It carries no path and no value, and names the
 * remedy the digest refusal names: the confirmation is built again from what is there now.
 */
export const FS_SCOPE_CHANGED =
  "The project's file scope changed after you confirmed. Open the list again.";

/** What a host asks `prepareRun` to start: the workflow to resolve and the raw `name=value` inputs. */
export interface PrepareRunRequest {
  /** A path, an id or a slug, resolved against the project and the home exactly as `relavium run` does. */
  readonly workflow: string;
  /** The parsed `--input` arguments, before they are coerced against the declared inputs. */
  readonly rawInputs: Readonly<Record<string, string>>;
  /**
   * The digest (`workflowSourceDigest`) of the workflow text a person confirmed before this start. Absent, nothing is bound: the
   * shell commands pass none and behave as they always did. Present, the text this start reads must have exactly that digest, or the
   * start is refused (`WORKFLOW_SOURCE_CHANGED`) before the workflow is parsed and before the first workflow-related effect (the secret
   * port, keys, MCP consent and connect, the history and its lease, the engine). The configuration load and the host's own leg owner
   * come first.
   *
   * It binds the workflow file only; it does NOT bind a file the workflow names (the CLI reads no external agent file while preparing),
   * the project files `.relavium/project.toml` and `.relavium/workspace.toml` (read after the confirmation; they set `[defaults].fs_scope`
   * and add `mcp_servers` registrations), the global configuration, the consent grant log, the keychain, the pricing and catalog rows, or
   * the MCP tool lists discovered at connect time. A changed MCP command still meets the consent gate: consent is fingerprinted on the declaration.
   */
  readonly expectedSourceDigest?: string | undefined;
  /**
   * The file scope tier (`[defaults].fs_scope`, `sandboxed` when none is set) a person confirmed before this start, because it was named
   * in what they confirmed. Absent, nothing is bound. Present, the tier THIS start resolves must be the same one, or the start is refused
   * ({@link FS_SCOPE_CHANGED}) before the workflow is parsed and before the first workflow-related effect, as the digest is. It binds the
   * tier only: the rest of the project files stay as {@link expectedSourceDigest} describes.
   */
  readonly expectedFsScope?: NonNullable<ResolvedConfig['fsScope']> | undefined;
}

/** The injectable services a start uses. Every member is the one `RunCommandDeps` already carries. */
export interface PrepareRunDeps {
  readonly io: CliIo;
  readonly global: Pick<GlobalOptions, 'cwd' | 'configPath'>;
  /**
   * The operator home the configuration is loaded from (`~/.relavium` lives under it). Absent, the OS home: that is what the shell uses.
   * A host that was handed one (the Home's tests) forwards it, so a start reads the same home a resume does and no test needs a module
   * mock to keep a start off the real one.
   */
  readonly home?: string | undefined;
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  readonly providers?: ProviderResolver;
  /** Construct key/provider services only after complete pure input admission. */
  readonly resolveKeys?: () => {
    readonly providers: ProviderResolver;
    readonly mcpSecretResolver: McpSecretResolver;
  };
  readonly openRunStore?: (
    workflow: WorkflowDefinition,
    homeDir: string,
    projectRoot: string,
    captureClose?: (close: () => void) => void,
    noticeContext?: LocalDbNoticeContext,
  ) => OpenedHistory;
  readonly startMcpClient?: typeof import('@relavium/mcp').startMcpClient;
  readonly mcpSecretResolver?: McpSecretResolver;
}

/**
 * The prompts a start may need, as ports. The shell supplies the clack and stdin implementations; the Home
 * supplies its own native ones ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1).
 */
export interface PrepareRunPorts {
  /**
   * The declared `secret` inputs, by name, once the workflow has parsed and the ordinary inputs were admitted.
   * `{}` when the host supplies none. A host that consumed a stream for them is also the host that must not
   * prompt afterwards: it builds {@link PrepareRunPorts.consentGate} accordingly.
   */
  readonly secretInputs: (
    workflow: WorkflowDefinition,
  ) => Promise<Readonly<Record<string, string>>>;
  /** The MCP stdio consent gate, built at the point the connector's options are assembled. */
  readonly consentGate: (homeDir: string) => StdioConsentGate;
  /**
   * The commit point of the leg, called once by {@link PreparedRun.start} after its last checkpoint and immediately before the engine
   * starts the run, with no await between. A host that ties a flow's cancel to the leg lets go of it here (see
   * `ResumeRunPorts.commit`, where the point is not optional in effect: a resume's engine takes the run before it returns). The shell
   * passes none.
   */
  readonly commit?: (() => void) | undefined;
}

/** A start that is ready: the engine is built and reconciled, and nothing has been started yet. */
export interface PreparedRun {
  readonly engine: WorkflowEngine;
  /** The augmented workflow the store froze and the engine will run: the one executed graph. */
  readonly workflow: WorkflowDefinition;
  /** The durable history this run writes, absent on the in-memory embedding path. */
  readonly history: OpenedHistory | undefined;
  /** The global content-addressed store root, present exactly when durable history is. */
  readonly mediaCasRoot: string | undefined;
  readonly mediaGcGraceMs: ResolvedConfig['mediaGcGraceMs'];
  /**
   * Start the prepared workflow on the prepared engine and adopt its handle: the one place the start options are written. A
   * preparation starts ONE run: a second call throws an `internal` error ({@link PREPARED_RUN_REUSED}) and starts nothing,
   * whatever the first call did.
   */
  readonly start: () => RunHandle;
}

/**
 * **A confirmed start runs the file that was confirmed** (LAUNCH-5), under the file scope that was named. Checked on the very text parsed
 * after it, so there is no second read between the check and the parse. What precedes it: the host's leg owner (registered by the host
 * before `prepareRun`, and retired on a refusal) and the configuration load (which may tighten the global config file's mode). What
 * follows it, and so does not happen for a refused start: the parse, the secret port, key resolution, the MCP consent card and spawn,
 * opening the history, the engine, `reconcile` and the lease.
 */
function assertConfirmedStart(
  request: PrepareRunRequest,
  config: ResolvedConfig,
  yaml: string,
): void {
  if (request.expectedSourceDigest !== undefined)
    assertWorkflowSourceDigest(request.expectedSourceDigest, yaml);
  // The scope named in the confirmation is the scope this start runs under: a project file that changed in between is a different run.
  if (
    request.expectedFsScope !== undefined &&
    (config.fsScope ?? 'sandboxed') !== request.expectedFsScope
  )
    throw new CliError('invalid_invocation', FS_SCOPE_CHANGED);
}

/**
 * Open the durable history behind the lifetime's checkpoints, classifying only this open operation as a storage fault (engine and work
 * faults keep their own boundary). `undefined` when the deps carry no store opener (the in-memory embedding path).
 */
function openHistory(
  deps: PrepareRunDeps,
  lifetime: RunLifetime,
  resources: RunResources,
  runWorkflow: WorkflowDefinition,
  homeDir: string,
): OpenedHistory | undefined {
  const openRunStore = deps.openRunStore;
  if (openRunStore === undefined) return undefined;
  try {
    return acquireNativeResource(
      (captureClose) =>
        openRunStore(runWorkflow, homeDir, deps.global.cwd, captureClose, {
          io: deps.io,
          invocation: lifetime.invocation,
        }),
      {
        assertAdmitting: () => lifetime.checkpoint(),
        captureClose: (close) => {
          resources.captureHistoryClose(close);
        },
        cleanupUncertain: (cause) => lifetime.cleanupFailed(cause),
        isStoppedFailure: (cause) => lifetime.isStoppedFailure(cause),
      },
    );
  } catch (err) {
    // Classify only this open operation; engine/work faults retain their own boundary.
    throw storageBoundaryError(err);
  }
}

/** What `durableEngineOptions` is built from. */
interface DurableWiringInput {
  /** The options of a run with no durable history: the providers, the tool environment, the notices and the MCP arm. */
  readonly base: BuildEngineOptions;
  readonly history: OpenedHistory;
  readonly def: WorkflowDefinition;
  readonly config: ResolvedConfig;
  readonly homeDir: string;
  readonly cwd: string;
  readonly lifetime: RunLifetime;
  readonly io: CliIo;
}

/**
 * The engine options of a run whose history is durable: the effect journal and its read half, the durable host with its lease and
 * outbox, the media wiring and the user-pricing overlay, over the base options. `mediaCasRoot` is hoisted for the run-end host media GC
 * the host runs.
 *
 * Media host-wiring (2.S): the SAME `~/.relavium/history.db` connection backs the `model_catalog` reader (→ `resolveMediaSurface`
 * routing) + the `media_references` retention junction, and the host gets the global CAS root (`~/.relavium/media/`) + the
 * project-relative `save_to` root (`.relavium/runs/`). Absent (the in-memory unit/harness path) ⇒ no media ports, so a media-producing
 * run fails loud — never a silent leak. The per-modality `media_cost_estimate` default folds in from config.
 */
function durableEngineOptions(input: DurableWiringInput): {
  readonly engineOptions: BuildEngineOptions;
  readonly mediaCasRoot: string | undefined;
} {
  const { base, history, def, config, homeDir, cwd, lifetime, io } = input;
  const wiring = buildMediaEngineWiring(
    history.db,
    homeDir,
    cwd,
    config,
    lifetime.notification((m: string) => io.writeErr(`${m}\n`)),
  );
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
  return {
    mediaCasRoot: wiring.media.casRoot,
    engineOptions: {
      ...base,
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
        operatorHomeDir: homeDir,
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
    },
  };
}

/**
 * The part of `relavium run` that does not depend on how the process is hosted
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1): resolve and
 * validate the workflow, admit the inputs and secrets, pre-flight the keys and the catalog, connect the MCP
 * servers behind the consent gate, open the durable history, build the engine and reconcile.
 *
 * The order is the contract: every refusal that needs no service happens before any key, MCP client, store
 * or engine exists, and the history is opened only after the MCP connect because it freezes the augmented
 * definition. What it acquires is registered in `resources`; the caller releases that in its own `finally`.
 */
export async function prepareRun(
  request: PrepareRunRequest,
  deps: PrepareRunDeps,
  ports: PrepareRunPorts,
  lifetime: RunLifetime,
  resources: RunResources,
): Promise<PreparedRun> {
  const { rawInputs } = request;
  const nativeProcesses = nativeProcessesForInvocation(lifetime.invocation);
  const build = deps.buildEngine ?? defaultBuildEngine;

  // Config (2.B) — a malformed layer surfaces as exit 2; the project dir powers id/slug discovery,
  // homeDir locates `~/.relavium/history.db` (2.H).
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
    ...(deps.home === undefined ? {} : { home: deps.home }),
  });

  const source = resolveWorkflowSource(request.workflow, {
    cwd: deps.global.cwd,
    projectConfigDir,
    homeDir,
  });

  assertConfirmedStart(request, config, source.yaml);

  const def = parseOrRefuse(source.yaml, sourceLabel(deps.global.cwd, source.path));
  assertOrdinaryInputsAllowed(def, rawInputs);
  const secretInputs = await ports.secretInputs(def);
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
  // Before any key is resolved: a grant this path cannot serve is refused with nothing read (2.6.A, MVP-1).
  assertWorkflowToolArmsWired(def, unwiredToolArms(RUN_TOOL_PROFILE));
  lifetime.checkpoint();
  const keys = deps.resolveKeys?.();
  lifetime.checkpoint();
  // Preserve injected precedence, sharing the admitted run's resolver with provider preflight.
  const providers = deps.providers ?? keys?.providers ?? createProviderResolver(deps.io.env);

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

  // Inbound MCP (2.R Step 3b): aggregate the `mcp_servers` declared by the workflow's INLINE agents, start
  // them fail-loud (a connect/discovery failure is an exit-2 CliError, cause stripped), and rewrite the
  // workflow so each inline agent's grant includes ONLY its own servers' discovered tools. `undefined` ⇒ no
  // inline agent declared a server. The spawned children are torn down by the host's release.
  const mcpRuntime = await resources.connectMcp(() =>
    connectWorkflowMcp(def, {
      ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
      cwd: deps.global.cwd,
      connectSignal: lifetime.signal,
      assertAdmitting: () => lifetime.checkpoint(),
      onFailure: (cause) => {
        if (!lifetime.isStoppedFailure(cause)) lifetime.failure(cause);
      },
      onCloseError: resources.reportMcpCloseFailure,
      budget: lifetime.invocation.registry.budget,
      work: resources.mcpWork,
      resolveSecret:
        deps.mcpSecretResolver ?? keys?.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env),
      registrations: config.mcpServers,
      // The file that declared them, for the prompt — the imported-artifact case naming its own file (§7).
      artifact: source.path,
      // **Consent before any spawn** (ADR-0084 §1). Injectable so a fixture drives it without a terminal;
      // the host's port owns the default, so an un-wired test path is a decision rather than an accident.
      consentGate: ports.consentGate(homeDir),
      ...(deps.startMcpClient === undefined ? {} : { startMcpClient: deps.startMcpClient }),
    }),
  );
  lifetime.checkpoint();
  if (mcpRuntime !== undefined) surfaceMcpSkipped(deps.io, mcpRuntime.client.skipped);
  const runWorkflow = mcpRuntime?.workflow ?? def;

  // Durable history (2.H): open `~/.relavium/history.db` and run THIS workflow on a host backed by the
  // SQLite `RunStore`, so every node-boundary/terminal event is persisted before delivery (ADR-0036).
  // Tests and the 2.K harness omit `openRunStore` → the in-memory default host, no DB touched. `close()`
  // releases the connection at run end (the host's release). A persist failure rejects out of the engine
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
  const opened = openHistory(deps, lifetime, resources, runWorkflow, homeDir);

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
    operatorHomeDir: homeDir,
    workspaceDir: deps.global.cwd,
    fsScopeTier: config.fsScope ?? 'sandboxed',
  };
  // ADR-0071 §6: an authored `reasoning_effort` the bound model does not accept is WITHHELD — and reported. To
  // STDERR, never stdout: `--json` owns stdout, and a warning line in the middle of the machine-readable stream
  // would be a parse error for whatever is consuming the run. Silence was the alternative, and it is worse: the
  // run succeeds, the knob does nothing, and the bill arrives at the provider's default tier.
  // `onceEffortNotice`: the gate is consulted on EVERY agent-node execution, so an agent inside a `loop` would
  // otherwise print the same warning on every iteration. A withheld tier is a standing condition, not an event.
  const onEffortWithheld = onceEffortNotice(
    lifetime.notification((note: string): void => deps.io.writeErr(`warning: ${note}\n`)),
  );
  // ADR-0071 §K7: a turn ran on a model we could not price, so `budget.max_cost_microcents` did not apply. The
  // governor already dedups per model. STDERR, never stdout (`--json`). `budget.strict_cost_cap` blocks instead.
  const onUnpriced = lifetime.notification(
    (model: string, capMicrocents: number, modalities?: readonly MediaBilledModality[]): void =>
      deps.io.writeErr(
        `warning: ${unpricedModelNote(model, capMicrocents, 'budget.strict_cost_cap', modalities)}\n`,
      ),
  );
  const baseOptions: BuildEngineOptions = {
    providers,
    toolEnv,
    onEffortWithheld,
    onUnpriced,
    ...mcpOption,
  };
  const durable =
    opened === undefined
      ? undefined
      : durableEngineOptions({
          base: baseOptions,
          history: opened,
          def,
          config,
          homeDir,
          cwd: deps.global.cwd,
          lifetime,
          io: deps.io,
        });
  const engineOptions = durable?.engineOptions ?? baseOptions;
  const mediaCasRoot = durable?.mediaCasRoot;
  lifetime.checkpoint();
  const engine = await build(engineOptions);
  lifetime.adoptEngine(engine);
  lifetime.checkpoint();
  // **Reconcile before starting (ADR-0078 §4/§5, ADR-0079 §7; 2.6.G liveness).** This is "the next
  // `relavium` start" that the `durabilityUncertain` exit code tells the user to wait for: `reconcile()`
  // first drains the terminal outbox (`~/.relavium/terminal-outbox.ndjson`), then settles every run a dead
  // process left `running` as `run:failed` (`effect_needs_attention` for an unresolved external effect, else
  // `budget_exceeded` after a recorded budget rejection, else `internal`). It leaves alone a run parked at a
  // gate, a run younger than one lease TTL and a run whose lease is live — another process is executing it. Best-effort — a run that cannot start because an unrelated run could not be repaired
  // would be the wrong trade.
  await engine.reconcile().catch(() => undefined);
  let started = false;
  return {
    engine,
    workflow: runWorkflow,
    history: opened,
    mediaCasRoot,
    mediaGcGraceMs: config.mediaGcGraceMs,
    start: () => {
      // One preparation, one run (the `RunResources` rule: a reuse is a host bug, named by fixed text). The flag is set before anything
      // else can throw, so a start that failed (a stop, a plan refusal) cannot be retried into a second leg off the same engine,
      // lease and frozen definition.
      if (started) throw new CliError('internal', PREPARED_RUN_REUSED);
      started = true;
      // The AUGMENTED workflow — the same one the store froze above, so the durable snapshot and the executed
      // graph are one thing rather than two that happen to be close.
      // `toolGrantsFinal`: the MCP servers were connected and the workflow rewritten above, so every inline
      // agent's `tools` already includes what its servers discovered. That makes the plan-build narrowing
      // check correct here (ADR-0094) — a node listing a tool its agent lacks is refused before the run id
      // exists, rather than partway through, after upstream nodes have spent money.
      lifetime.checkpoint();
      ports.commit?.();
      const handle = engine.start({
        workflow: runWorkflow,
        eventConsumption: 'iterated',
        inputs,
        planOptions: { toolGrantsFinal: true },
      });
      lifetime.adoptHandle(handle);
      return handle;
    },
  };
}
