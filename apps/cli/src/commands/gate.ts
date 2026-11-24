import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import type { CliInvocation } from '../process/invocation.js';
import type { defaultSubscribeSignals } from '../process/signals.js';
import { WorkflowLifetime } from './workflow-lifetime.js';
import type { RendererCreationOwner } from './workflow-terminal.js';
import { finishLeg } from '../run-core/finish-leg.js';
import { resumeRun, secretPipeHint, type ResumeRunPorts } from '../run-core/resume-run.js';
import { RunResources } from '../run-core/run-resources.js';
import { Readable } from 'node:stream';

import type { WorkflowEngine } from '@relavium/core';
import type { Db } from '@relavium/db';
import type { GateDecision } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import type { BuildEngineOptions } from '../engine/build-engine.js';
import { sweepHostMediaBestEffort as defaultSweepMedia } from '../engine/media-gc.js';
import type { ProviderResolver } from '../engine/providers.js';
import { decisionFromFlags, type GateFlags } from '../gate/decision.js';
import { budgetDecisionFromFlags, type BudgetDecisionFlags } from '../gate/budget.js';
import type { StdioConsentGate } from '../engine/mcp-servers.js';
import { createConsentGate } from '../engine/mcp-consent-gate.js';
import { createBoundConsentPrompter } from '../mcp/consent-prompt.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import type { GatePrompter } from '../gate/prompter.js';
import { selectGatePrompter } from '../gate/select-prompter.js';
import { readSecretFromStdin, type StdinSecretContext } from '../secrets/read-secret.js';
import { parseSecretLines } from '../secrets/parse-secret-lines.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
import { driveRun } from './drive.js';

// The selection, the save-to root and the hold notice are the shared resume core's; they are re-exported
// here because this module has always been where they are imported from.
export { legacyMediaJobHoldNotice, resolveSaveToRoot, selectGate } from '../run-core/resume-run.js';

export interface ResumeGateArgs {
  readonly runId: string;
  /** `--gate <gateId>`: which pending gate to resolve (required only when more than one is pending). */
  readonly gate?: string;
  /**
   * `--secret-stdin`: re-supply the run's `secret` inputs from stdin, one `name=value` per line
   * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
   * §6). A `secret` is never persisted — the durable record holds only a masked slot — so a secret-bearing
   * run cannot resume without it, and before this flag existed the only advice was "re-run the workflow".
   *
   * **Values never travel through argv**, which is why the flag is a boolean and not `--secret name=value`:
   * a credential on a command line leaks to `ps`, shell history and CI logs. `relavium provider set-key`
   * takes a key on stdin for exactly this reason.
   */
  readonly secretStdin?: boolean;
  readonly allowMcpStdio?: readonly string[];
}

export interface GateCommandArgs extends ResumeGateArgs, GateFlags {}
export interface BudgetCommandArgs extends ResumeGateArgs, BudgetDecisionFlags {}

export interface GateCommandDeps {
  /** The original bootstrap invocation; native authority stays host-only. */
  readonly invocation?: CliInvocation;
  readonly subscribeSignals?: typeof defaultSubscribeSignals;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable so tests drive a stub provider + the in-memory host engine. */
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  /** Injectable provider seam (the engine's resolver for a post-gate agent node). Defaults to the env resolver. */
  readonly providers?: ProviderResolver;
  /** Injectable history-db opener — tests pass an in-memory db; production opens `~/.relavium/history.db`. */
  readonly openDb?: (
    homeDir: string,
    captureClose?: (close: () => void) => void,
    noticeContext?: LocalDbNoticeContext,
  ) => { db: Db; close: () => void };
  readonly selectRenderer?: (
    io: CliIo,
    global: GlobalOptions,
    creation?: RendererCreationOwner,
  ) => RunRenderer;
  readonly selectGatePrompter?: (io: CliIo, global: GlobalOptions) => GatePrompter | undefined;
  /** Injectable run-end host media GC (2.S/D-GC); defaults to {@link defaultSweepMedia}. Tests spy on it. */
  readonly sweepMedia?: typeof defaultSweepMedia;
  /**
   * Read the whole of stdin, for `--secret-stdin`. Injected so a test never touches the real stdin — and
   * never has to put a credential-shaped string anywhere but its own closure.
   */
  readonly readSecretInput?: () => Promise<string>;
  readonly startMcpClient?: typeof import('@relavium/mcp').startMcpClient;
  readonly consentGate?: StdioConsentGate;
  readonly mcpSecretResolver?: McpSecretResolver;
  /** After selection/amount refusal, production reads providers from the command's existing db. */
  readonly resolveKeys?: (db: Db) => {
    readonly providers: ProviderResolver;
    readonly mcpSecretResolver: McpSecretResolver;
  };
}

/**
 * The `relavium gate` core (**2.G**) — resolve a pending human gate from the terminal, the surface-agnostic
 * resume path for a `human_gate:paused` run (an interactive run that paused, or a CI run that exited `3`). It
 * runs in a **fresh process** from the original `relavium run`, so it rebuilds the run's `WorkflowDefinition`
 * + inputs from the durable snapshot (2.H), reconstructs the checkpoint from the persisted event log
 * (`createHistoryCheckpointer`), and calls `engine.resumeFromCheckpoint` over the same store — then drives the
 * resumed run to its terminal through the shared {@link driveRun} core.
 *
 * Resume is **idempotent**: a doubled decision (the run already finished, or this gate was already resolved) is
 * a clean exit-`0` no-op, never a double-advance — leaning on the engine's checkpoint/gate-state idempotency.
 * Flag/lookup faults are typed {@link CliError}s (exit `2`); run-time outcomes map to `0`/`1`/`3`.
 */
export async function gateCommand(args: GateCommandArgs, deps: GateCommandDeps): Promise<ExitCode> {
  // Validate the resolution flags FIRST (cheap, before touching the db): exactly one of --approve/--reject/
  // --input, mutually exclusive, --comment not with --input.
  const flags = decisionFromFlags(args);
  if (!flags.ok) {
    throw new CliError('invalid_invocation', flags.error);
  }
  return resumeGateCommand(args, deps, 'human', flags.decision);
}

/** Exact amount transport is validated before any database, secret, MCP or ownership access. */
export async function budgetCommand(
  args: BudgetCommandArgs,
  deps: GateCommandDeps,
): Promise<ExitCode> {
  return resumeGateCommand(args, deps, 'budget', budgetDecisionFromFlags(args));
}

async function resumeGateCommand(
  args: ResumeGateArgs,
  deps: GateCommandDeps,
  kind: 'human' | 'budget',
  decision: GateDecision,
): Promise<ExitCode> {
  const lifetime = new WorkflowLifetime(deps.invocation, deps.io, deps.subscribeSignals);
  return lifetime.execute(() => resumeGateOwned(args, deps, kind, decision, lifetime));
}

async function resumeGateOwned(
  args: ResumeGateArgs,
  deps: GateCommandDeps,
  kind: 'human' | 'budget',
  decision: GateDecision,
  lifetime: WorkflowLifetime,
): Promise<ExitCode> {
  lifetime.checkpoint();
  const { config, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const resources = new RunResources(lifetime, deps.io);
  const interruptedBeforeResume = (): ExitCode => {
    deps.io.writeErr(
      'resume interrupted before a decision was recorded; the gate remains pending\n',
    );
    return EXIT_CODES.workflowFailed;
  };
  try {
    // Consuming stdin removes prompt authority for this invocation, even with stale TTY metadata.
    const mayPrompt = args.secretStdin !== true;
    const promptIo = mayPrompt ? deps.io : { ...deps.io, stdinIsTty: false };
    // The shared resume core (`resumeRun`) reloads the snapshot, reconstructs the checkpoint, selects and
    // checks the decision, re-supplies the secrets, reconnects MCP, builds the engine and resumes. The
    // prompts and the database are ports: the shell reads secrets from bounded stdin, asks for stdio
    // consent with the clack prompt and opens `~/.relavium/history.db`, exactly as before the core was shared.
    const resumed = await resumeRun(
      { runId: args.runId, gate: args.gate, secretStdin: args.secretStdin, kind, decision },
      deps,
      { config, homeDir },
      {
        openDb: (captureClose) =>
          deps.openDb === undefined
            ? openLocalDb(homeDir, undefined, captureClose, {
                io: deps.io,
                invocation: lifetime.invocation,
              })
            : deps.openDb(homeDir, captureClose, {
                io: deps.io,
                invocation: lifetime.invocation,
              }),
        secretInputs: readGateSecrets(args, deps, lifetime),
        consentGate: (consentHome) =>
          deps.consentGate ??
          createConsentGate({
            io: promptIo,
            global: deps.global,
            homeDir: consentHome,
            allowedDigests: args.allowMcpStdio ?? [],
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
    if (resumed.kind === 'settled') {
      // A doubled decision (run finished / gate already resolved) — a clean no-op, NOT a double-advance.
      if (deps.global.json) deps.io.writeErr(`${resumed.message}\n`);
      else deps.io.writeOut(`${resumed.message}\n`);
      return EXIT_CODES.success;
    }
    const { engine, handle, db, mediaCasRoot } = resumed;

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: (creation) =>
        (deps.selectRenderer ?? selectRenderer)(deps.io, deps.global, creation),
      // A later gate cannot read the stdin stream already consumed for re-supplied secrets.
      makeGatePrompter: () =>
        mayPrompt
          ? (deps.selectGatePrompter ?? selectGatePrompter)(promptIo, deps.global)
          : undefined,
      io: deps.io,
      json: deps.global.json,
    });

    // The shared epilogue (`finishLeg`): the departure, the exit code, the retention passes, and the two
    // rules only a resumed leg has — a taken-over run refuses with `run_owned_elsewhere` before any sweep,
    // and a run that closed already settled is a clean exit-0 no-op.
    return await finishLeg({
      leg: 'resume',
      runId: args.runId,
      lifetime,
      io: deps.io,
      json: deps.global.json,
      handle,
      outcome,
      db,
      mediaCasRoot,
      mediaGcGraceMs: config.mediaGcGraceMs,
      sweepMedia: deps.sweepMedia ?? defaultSweepMedia,
    });
  } catch (err) {
    // The pre-connect guard owns child cleanup; this command owns the run-style interruption exit.
    // Once resume has started, the handle/engine error remains authoritative.
    if (lifetime.isStoppedFailure(err)) return interruptedBeforeResume();
    lifetime.failure(err);
    throw err;
  } finally {
    // An unacknowledged MCP release keeps the process alive for its exit authority: the database stays open.
    if (!(await resources.releaseMcp())) await new Promise<never>(() => {});
    resources.closeHistoryDb();
  }
}

/** The two refusals `readSecretFromStdin` prints, written for THIS command rather than `provider set-key`. */
const SECRET_STDIN_CONTEXT = (
  runId: string,
  resumeInvocation: string | undefined,
): StdinSecretContext => ({
  pipeHint: secretPipeHint(resumeInvocation),
  emptyMessage: `no \`secret\` inputs were read from stdin for run ${runId} (empty input).`,
});

/**
 * The shell's secret port for a resume: `name=value` lines from the bounded stdin reader (or the injected
 * fixture reader), parsed by the shared secret-line parser. The run core's `resolveSecretInputs` refuses a
 * missing or unexpected slot name ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
 * §6); it does NOT refuse a blank value — that refusal is `parseSecretLines`, called here, so a host port
 * that does not use it must refuse a blank value itself.
 */
function readGateSecrets(
  args: ResumeGateArgs,
  deps: GateCommandDeps,
  lifetime: WorkflowLifetime,
): ResumeRunPorts['secretInputs'] {
  return async ({ resumeInvocation }) => {
    const read =
      deps.readSecretInput ??
      ((): Promise<string> => {
        if (!(deps.io.stdin instanceof Readable)) throw new CliError('cli_internal', '');
        return readSecretFromStdin(
          SECRET_STDIN_CONTEXT(args.runId, resumeInvocation),
          deps.io.stdin,
          {
            signal: lifetime.signal,
            onFailure: (cause) => lifetime.failure(cause),
          },
        );
      });
    const raw = await read();
    lifetime.checkpoint();
    return parseSecretLines(raw, `run ${args.runId}`);
  };
}
