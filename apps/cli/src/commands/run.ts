import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import type { CliInvocation } from '../process/invocation.js';
import type { defaultSubscribeSignals } from '../process/signals.js';
import type { RendererCreationOwner } from './workflow-terminal.js';
import { WorkflowLifetime } from './workflow-lifetime.js';
import { prepareRun } from '../run-core/prepare-run.js';
import { RunResources } from '../run-core/run-resources.js';

import type { WorkflowDefinition, WorkflowEngine } from '@relavium/core';

import type { BuildEngineOptions } from '../engine/build-engine.js';
import { sweepCommittedEffects } from '../engine/effect-retention.js';
import { type StdioConsentGate } from '../engine/mcp-servers.js';
import {
  sweepHostMediaBestEffort as defaultSweepMedia,
  sweepMediaAtTerminal,
} from '../engine/media-gc.js';
import type { ProviderResolver } from '../engine/providers.js';
import type { GatePrompter } from '../gate/prompter.js';
import { selectGatePrompter } from '../gate/select-prompter.js';
import type { OpenedHistory } from '../history/open.js';
import { createConsentGate } from '../engine/mcp-consent-gate.js';
import { createBoundConsentPrompter } from '../mcp/consent-prompt.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import { parseSecretLines } from '../secrets/parse-secret-lines.js';
import {
  readSecretFromStdin,
  type StdinSecretContext,
  type StdinSecretSource,
} from '../secrets/read-secret.js';
import { driveRun, isTerminalOutcome, outcomeToExitCode } from './drive.js';
import { parseInputArgs } from './inputs.js';

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
    captureClose?: (close: () => void) => void,
    noticeContext?: LocalDbNoticeContext,
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
export async function runCommand(args: RunCommandArgs, deps: RunCommandDeps): Promise<ExitCode> {
  const lifetime = new WorkflowLifetime(deps.invocation, deps.io, deps.subscribeSignals);
  return lifetime.execute(() => runOwned(args, deps, lifetime));
}

async function runOwned(
  args: RunCommandArgs,
  deps: RunCommandDeps,
  lifetime: WorkflowLifetime,
): Promise<ExitCode> {
  lifetime.checkpoint();
  if ((deps.global.allowFsRoots?.length ?? 0) > 0) {
    throw new CliError(
      'invalid_invocation',
      '--allow-fs-root applies only to Home, chat, chat-resume and agent run.',
    );
  }
  // Syntax faults do not need even configuration or workflow reads.
  const rawInputs = parseInputArgs(args.input);
  const mayPrompt = args.secretInputsStdin !== true;
  const promptIo = mayPrompt ? deps.io : { ...deps.io, stdinIsTty: false };

  // What the preparation acquires — the MCP clients and the history database — is registered here and
  // released in the `finally` below, so an early refusal and a finished run end the same way.
  const resources = new RunResources(lifetime, deps.io);
  try {
    // The shared run core (`prepareRun`) resolves, admits, pre-flights, connects MCP, opens the history,
    // builds and reconciles. The prompts are ports: the shell reads secrets from bounded stdin and asks
    // for stdio consent with the clack prompt, exactly as before the core was shared.
    const prepared = await prepareRun(
      { workflow: args.workflow, rawInputs },
      deps,
      {
        secretInputs: (def) => readRunSecrets(args, deps, def, lifetime),
        consentGate: (homeDir) =>
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
      },
      lifetime,
      resources,
    );
    const { engine, history } = prepared;
    const handle = prepared.start();

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

    // Both retention passes are optional: do not start new maintenance after the original deadline.
    // Already-entered work and mandatory engine/input/MCP/database joins retain their own barriers.
    // Host media GC (2.S/D-GC, ADR-0042 §4) — best-effort, keyed on a TERMINAL outcome: the clean-terminal reclaim
    // retry + the grace-window byte reclaim + the CAS-orphan sweep, over the same durable `history.db`. Skipped on
    // a `paused` outcome (resumable — its media must survive) and the in-memory path (no CAS). See
    // sweepMediaAtTerminal for the guard + the never-fail-the-run swallow.
    // Retention (effect-journal.md §9). A terminal run can no longer be resumed — `resumeFromCheckpoint`
    // returns a closed handle for one — so its COMMITTED rows have no reader left and go. Unresolved rows
    // are untouched by construction: they are the record an operator needs, and an exit-7 run's rows must
    // survive precisely because its run is over.
    // `history` is undefined for an in-memory embedding/test path, which has no journal to sweep.
    if (
      isTerminalOutcome(outcome) &&
      history !== undefined &&
      lifetime.invocation.registry.budget.remainingMs() !== 0
    ) {
      sweepCommittedEffects(deps.io, history.db, handle.runId, lifetime.effectNoticeOwner);
    }
    await sweepMediaAtTerminal({
      sweep: deps.sweepMedia ?? defaultSweepMedia,
      isTerminal: isTerminalOutcome(outcome),
      db: history?.db,
      casRoot: prepared.mediaCasRoot,
      currentRunId: handle.runId,
      graceMs: prepared.mediaGcGraceMs,
      budget: lifetime.invocation.registry.budget,
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
    // An unacknowledged MCP release keeps the process alive for its exit authority: the database stays open.
    if (!(await resources.releaseMcp())) await new Promise<never>(() => {});
    resources.closeHistoryDb();
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
  const read =
    deps.readSecretInput ??
    ((): Promise<string> => {
      if (!isSecretInputSource(deps.io.stdin))
        throw new CliError(
          'invalid_invocation',
          'Secret input requires an async-iterable stdin source.',
        );
      return readSecretFromStdin(RUN_SECRET_STDIN_CONTEXT, deps.io.stdin, {
        signal: lifetime.signal,
        onFailure: (cause) => lifetime.failure(cause),
      });
    });
  const raw = await read();
  lifetime.checkpoint();
  return parseSecretLines(raw, 'run --secret-inputs-stdin');
}

/** Native and embedding inputs share the reader's structural source contract. */
function isSecretInputSource(
  value: NodeJS.ReadableStream,
): value is NodeJS.ReadableStream & StdinSecretSource {
  try {
    return typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
  } catch {
    return false;
  }
}
