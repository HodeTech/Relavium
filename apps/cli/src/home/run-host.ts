import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { RunDeparture, RunHandle, WorkflowDefinition, WorkflowEngine } from '@relavium/core';
import { createRunHistoryStore, loadRunSnapshot, type Db } from '@relavium/db';
import { MaskedSecretSchema, type GateDecision } from '@relavium/shared';

import { driveRun, type RunOutcome } from '../commands/drive.js';
import { faultForTranscript } from '../config/config-error-text.js';
import { loadResolvedConfig } from '../config/load.js';
import { createConsentGate, type ConsentPrompter } from '../engine/mcp-consent-gate.js';
import type { StdioConsentGate } from '../engine/mcp-servers.js';
import { sweepHostMediaBestEffort } from '../engine/media-gc.js';
import { terminalOutboxPath, type OpenedHistory } from '../history/open.js';
import { isProjectRootHere, projectRootOf, recordedProjectRoot } from '../history/project-root.js';
import { CliError, isCliError, toUserFacing } from '../process/errors.js';
import { safetyRank } from '../process/exit-observations.js';
import type { CliInvocation } from '../process/invocation.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { HOSTED_RUN_EXIT_SETTLE_MS } from '../render/tui/tui-constants.js';
import type { RunJobControl } from '../render/run-job-control.js';
import { sanitizeInline, sanitizeUntrustedInline } from '../render/sanitize.js';
import { noticeSurfaceOf } from '../render/surface.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import { finishLeg, type LegKind } from '../run-core/finish-leg.js';
import {
  prepareRun,
  type PrepareRunDeps,
  type PrepareRunRequest,
} from '../run-core/prepare-run.js';
import type { RunLifetime, RunTerminalView } from '../run-core/run-lifetime.js';
import { resumeRun } from '../run-core/resume-run.js';
import { RunResources } from '../run-core/run-resources.js';
import type { RendererCreationOwner } from '../commands/workflow-terminal.js';
import { HostedRunLifetime, type HostedLegRetirement } from './hosted-run-lifetime.js';
import {
  describeHostedRunTerminal,
  displayRunId,
  relaviumRunCommand,
  takenOverTerminal,
  type HostedRunTerminal,
  type HostedRunTerminalInput,
} from './hosted-run-terminal.js';
import { RunNotices } from './run-notices.js';

/**
 * The values for a run's `secret` inputs, asked for by NAME, from the Home's native masked field
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4). A value lives
 * only in this call's result and in `resumeRun`'s argument; the host never keeps one.
 */
export type HostedSecretPort = (
  names: readonly string[],
) => Promise<Readonly<Record<string, string>>>;

/** Start a workflow from the Home's own project. The run's root is the Home's working directory, always. */
export interface HostedStartRequest {
  /** A path, an id or a slug, resolved exactly as `relavium run` resolves it. */
  readonly workflow: string;
  /** The `name=value` inputs, before they are coerced against the declared inputs. */
  readonly rawInputs: Readonly<Record<string, string>>;
  /** Asked for the declared `secret` inputs, once the workflow parsed and the ordinary inputs were admitted. */
  readonly secrets?: HostedSecretPort | undefined;
  /**
   * The digest of the workflow text the person confirmed (`workflowSourceDigest`, `run-core/source-digest.ts`). Present, the start reads the
   * file and is refused, before the workflow is parsed and before the first workflow-related effect (secrets, keys, MCP, history, engine),
   * when its text is not the confirmed one; the leg's own owner is registered first and retires on the refusal. Absent, nothing is
   * bound. It binds the workflow file only (see `PrepareRunRequest.expectedSourceDigest` for what it does not).
   */
  readonly expectedSourceDigest?: string | undefined;
  /**
   * The file scope tier the confirmation named (`PrepareRunRequest.expectedFsScope`): the start is refused, before anything else, when
   * the project's configuration resolves another one now. Absent, nothing is bound.
   */
  readonly expectedFsScope?: PrepareRunRequest['expectedFsScope'];
  /**
   * The cancel of the flow that asked for this start (Esc or Ctrl+C on `Starting the run…`). When it aborts BEFORE the leg's commit point
   * (the run core's last checkpoint, just before the engine starts the run), the leg's lifetime is stopped: the connect and the consent
   * card close, the next checkpoint of the run core throws, and the launch settles as `refused` / `stopped` with no run created. From
   * the commit point on it governs nothing: a started run is the run view's to cancel.
   */
  readonly signal?: AbortSignal | undefined;
}

/** Answer a parked run: the next leg, on a fresh engine, through the one resume core. */
export interface HostedResumeRequest {
  readonly runId: string;
  /** Which pending gate (required only when more than one is pending). */
  readonly gate?: string | undefined;
  readonly kind: 'human' | 'budget';
  readonly decision: GateDecision;
  /** Asked for the masked slots of a run that carries secrets; absent means the host supplies none. */
  readonly secrets?: HostedSecretPort | undefined;
  /**
   * The cancel of the flow that asked for this answer (Esc or Ctrl+C on `Answering the gate…`). It stops the leg while it prepares
   * (the secrets, the consent card, the connect, the engine build and its reconcile) and the launch settles as `refused` / `stopped`
   * with the run exactly as it was: the gate is still pending. It does NOT reach the engine: from the leg's commit point (the run core's
   * last checkpoint, just before `resumeFromCheckpoint`) it governs nothing, because a cancel that arrives while the engine prepares the
   * resume writes `run:cancelled`, which nothing can undo, and one Esc on a card decides nothing (ADR-0139 §4, §5). The leg that started
   * is a started leg; cancelling it takes the run view's two presses.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Continue a run that is parked on media jobs and nothing else ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §3): the next leg, on a fresh engine, through the same resume core and with no gate and no decision, because there are none to give.
 * It is a request of the same single-flight path as {@link HostedResumeRequest}: one leg at a time, the same owner, lease and teardown.
 */
export interface HostedMediaResumeRequest {
  readonly runId: string;
  readonly kind: 'media';
  /** Asked for the masked slots of a run that carries secrets (the engine needs them to continue); absent means the host supplies none. */
  readonly secrets?: HostedSecretPort | undefined;
  /**
   * The cancel of the flow that asked for this continue (Esc or Ctrl+C on `Continuing the run…`): the same as
   * {@link HostedResumeRequest.signal}. Before the leg's commit point it stops the leg and the run stays parked, its jobs untouched;
   * from it on it governs nothing, because cancelling the run would leave the jobs already paid for unfetched for good.
   */
  readonly signal?: AbortSignal | undefined;
}

/** Why a request was turned away before it cost anything. */
export type HostedRefusal =
  /** A leg is preparing or executing; a second is never queued. */
  | 'busy'
  /** The Home is closing. */
  | 'closing'
  /** The run belongs to another directory, or was recorded with none ([ADR-0139] §7). */
  | 'other_project'
  /** The leg was stopped before it started. */
  | 'stopped'
  /** This host has no invocation to register a leg's owner with. */
  | 'unavailable'
  /** The run core refused it (an invalid input, a missing key, a refused server, a stale gate). */
  | 'rejected';

export type HostedLaunch =
  | {
      /** The leg is executing in the background; `ended` settles with how it ended, and never rejects. */
      readonly kind: 'started';
      readonly leg: LegKind;
      readonly runId: string;
      readonly ended: Promise<HostedLegEnd>;
    }
  /** A resume found nothing to resume (the gate was already decided, or the run already ended). */
  | { readonly kind: 'settled'; readonly message: string }
  | { readonly kind: 'refused'; readonly reason: HostedRefusal; readonly message: string };

/** How one leg ended: view state for the Home, never an exit code ([ADR-0139] §3, §6). */
export interface HostedLegEnd {
  readonly leg: LegKind;
  readonly runId: string;
  /** Read from the handle's own disposition and the departure, never from a stream. */
  readonly terminal: HostedRunTerminal;
  /** The leg ended at a pause: the lease was handed back and a later leg answers it. */
  readonly handedOff: boolean;
  /** `retained` means the leg's cleanup was not acknowledged; its owner stays registered. */
  readonly retirement: HostedLegRetirement;
  /** The sanitized message of a fault that ended the leg abnormally, else `undefined`. */
  readonly fault: string | undefined;
}

/**
 * What the Home owes the person once the screen is restored: the leg that ended with a workflow safety fact (money not confirmed 8, an
 * effect needing attention 7, a held terminal 5, taken over elsewhere 6), or the one it had to abandon. One run, one line, and only
 * fixed vocabulary plus the sanitized run id.
 */
export interface HostedExitFact {
  readonly kind: 'safety' | 'abandoned';
  readonly runId: string;
  /** The sentence the Home prints: what happened, and the shell remedy. */
  readonly line: string;
}

export interface RunHostSnapshot {
  /** A request is between its confirmation and the engine's start result. */
  readonly launching: boolean;
  /** The leg that is preparing or executing, if any. */
  readonly active:
    | { readonly leg: LegKind; readonly runId: string | undefined; readonly cancelling: boolean }
    | undefined;
  /** How the most recent leg ended. */
  readonly last: HostedLegEnd | undefined;
}

export interface RunHostOptions {
  /** The Home's invocation: its registry owns every leg's owner. Absent, no leg can run. */
  readonly invocation: CliInvocation | undefined;
  readonly io: Pick<CliIo, 'env'>;
  readonly global: GlobalOptions;
  /**
   * The Home's own open connection ([ADR-0139] §2). Every leg runs on it, through an opener whose `close`
   * does nothing: the Home closes it, once, last.
   */
  readonly db: Db;
  /**
   * The operator home every leg's configuration is loaded from, and the one a notice names a config file from. REQUIRED: a host that
   * was not handed one would load `~/.relavium` from the OS, so a caller that forgot it (a test above all) would silently read the
   * operator's real files. The Home passes the home its own config load resolved.
   */
  readonly homeDir: string;
  /**
   * The Home's MCP consent card ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4,
   * [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7): asked, through the native prompt channel,
   * whether a local program a hosted leg wants to start may run. It is the ONLY prompt a hosted leg can open, and a leg with none
   * refuses an unapproved server with the digests, as a script does. `true` approves; anything else refuses and spawns nothing.
   */
  readonly consent?: ConsentPrompter | undefined;
  readonly notices?: RunNotices | undefined;
  /** The one reader's sink for a leg's events; the run view folds them. Absent, the events are dropped. */
  readonly renderer?:
    | ((leg: { readonly runId: string; readonly leg: LegKind }) => RunRenderer)
    | undefined;
  readonly buildEngine?: PrepareRunDeps['buildEngine'];
  readonly providers?: PrepareRunDeps['providers'];
  readonly startMcpClient?: PrepareRunDeps['startMcpClient'];
  readonly mcpSecretResolver?: McpSecretResolver | undefined;
  readonly sweepMedia?: typeof sweepHostMediaBestEffort | undefined;
  /** Test seam: the one place a leg's resources are made. */
  readonly createResources?: ((lifetime: RunLifetime, io: CliIo) => RunResources) | undefined;
  /** How much longer `close` waits for a stopped leg (default {@link HOSTED_LEG_SETTLE_BOUND_MS}). */
  readonly settleBoundMs?: number | undefined;
  /**
   * The timer behind that bound: call `callback` once after `delayMs` and return the function that cancels it. Default is a referenced
   * `setTimeout` (the bound must hold even when nothing else keeps the process alive); a test injects its own clock so nothing sleeps.
   */
  readonly schedule?: ((callback: () => void, delayMs: number) => () => void) | undefined;
  /**
   * The directory whose runs this host answers: its canonical root, the text a run records (`projectRootOf`). The Home passes the very
   * value it lists runs by; absent, it is `projectRootOf(global.cwd)`. A resume of a run recorded under any other root, or under none, is
   * refused before any work. The legs themselves still work in `global.cwd` as it was spelled.
   */
  readonly projectRoot?: string | undefined;
}

/** The services both cores read, with an absent one left out (the shell's own `exactOptionalPropertyTypes` shape). */
type Services = Pick<
  PrepareRunDeps,
  'buildEngine' | 'providers' | 'startMcpClient' | 'mcpSecretResolver'
>;

interface Acquired {
  readonly engine: WorkflowEngine;
  readonly handle: RunHandle;
  readonly runId: string;
  readonly db: Db | undefined;
  readonly mediaCasRoot: string | undefined;
  readonly mediaGcGraceMs: number | undefined;
}

type Acquisition = Acquired | { readonly settled: string };

interface LegContext {
  readonly lifetime: HostedRunLifetime;
  readonly resources: RunResources;
  readonly io: CliIo;
  /**
   * The leg's commit point (H1): lets go of the flow's cancel. The run core calls it after its last checkpoint and just before the engine
   * takes the run, so a cancel that lands later closes the flow and nothing else: a run the engine has taken is a started run, and
   * cancelling it takes the run view's two presses (ADR-0139 §5), never the one Esc on "Answering the gate…". Idempotent.
   */
  readonly commit: () => void;
}

interface ActiveLeg {
  readonly kind: LegKind;
  readonly lifetime: HostedRunLifetime;
  runId: string | undefined;
  /**
   * The leg's renderer, once the drive made it: held here so that a leg the host abandons can be sealed too (its frame loop must not
   * outlive the Home's attention), and so that the leg's own epilogue seals the very one it was given.
   */
  renderer: RunRenderer | undefined;
  /** Settles once the leg's whole teardown is done: stream joined, departed, MCP closed, owner retired. */
  done: Promise<void>;
}

const NOOP_RENDERER: RunRenderer = { onEvent: () => undefined };

/**
 * How much longer {@link RunHost.close} waits for a leg to settle, once it was asked to stop
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6). The Home's own wait for a confirmed exit
 * is the engine's grace window (ten seconds), and the host's `close` runs after it; a leg whose work ignores the cancel would otherwise
 * keep `close` (and with it the Home) waiting for ever. Past this bound the leg is ABANDONED: its owner stays registered, the invocation's
 * finite-exit bound is armed so the process ends, and the shared database is not closed under a leg that may still write to it.
 */
export const HOSTED_LEG_SETTLE_BOUND_MS = HOSTED_RUN_EXIT_SETTLE_MS;

/**
 * The Home has no terminal for a run to take: its run view is a screen of the Home's own tree, painted from the
 * events the one reader folds. This is the view a leg's `RunLifetime` is given: every member runs inline and
 * acquires nothing, and `seal()` is the Home closing.
 */
class HostedRunView implements RunTerminalView {
  #sealed = false;
  get sealed(): boolean {
    return this.#sealed;
  }
  seal(): void {
    this.#sealed = true;
  }
  releaseInput(): Promise<void> {
    return Promise.resolve();
  }
  createJobControl(): RunJobControl {
    return { dispose: () => undefined };
  }
  createRenderer(factory: (creation: RendererCreationOwner) => RunRenderer): RunRenderer {
    return factory({ acknowledgeNoAcquisition: () => undefined, adopt: () => undefined });
  }
  runPrompt<T>(factory: () => Promise<T>): Promise<T> {
    return factory();
  }
  runViewOperation<T>(factory: () => T | Promise<T>): Promise<T> {
    return Promise.resolve().then(factory);
  }
}

/** What a start says when it was stopped before the engine took the run. */
export const HOSTED_START_STOPPED = 'The run was stopped before it started.';

/**
 * What an answer or a continue says when a cancel stopped it before the engine took the run (the leg's commit point, H1): the person
 * pressed `Esc` or `Ctrl+C` while it was being prepared (a secret asked, a card open, an MCP server connecting). A cancel, not a refusal
 * nobody made (`was not approved`), and the run is exactly as it was: the gate is still pending, or the jobs are still parked.
 */
export const HOSTED_RESUME_CANCELLED = 'Cancelled. The run is as it was.';

function refused(reason: HostedRefusal, message: string): HostedLaunch {
  return { kind: 'refused', reason, message };
}

/**
 * Wrap the caller's secret port so a blank value never reaches the run core.
 *
 * The core checks only the NAMES of the secrets (a missing slot, an unexpected one). It would accept `''` as
 * "re-supplied", and a blank masked field is the likeliest way to produce one by accident; the shell refuses it
 * in `parseSecretLines`, which the Home does not use, so the refusal is this wrapper's. The message is fixed text:
 * it names neither a slot nor a value. The result is a fresh null-prototype map, so a name such as `__proto__`
 * is an own key the core's name check sees, never a prototype write.
 */
function refuseBlankSecrets(
  port: HostedSecretPort | undefined,
  names: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (port === undefined || names.length === 0) return Promise.resolve(out);
  return port(Object.freeze([...names])).then((supplied) => {
    for (const name of Object.keys(supplied)) {
      const value = supplied[name];
      if (typeof value !== 'string' || value.trim() === '')
        throw new CliError('invalid_invocation', 'A secret input cannot be blank.');
      out[name] = value;
    }
    return out;
  });
}

/** A non-null, non-array object (a guard, so no cast). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parked run's frozen inputs hold a masked `secret` slot. A durable record keeps only the slot (`{ secret: true, ref }`),
 * so the value must be supplied again to resume; a run with none has nothing to ask for, and the run core refuses a secret port it
 * was told to expect and did not need. A value that does not parse is left to the core to name.
 */
function carriesMaskedSlots(inputJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    return (
      isRecord(parsed) &&
      Object.keys(parsed).some((name) => MaskedSecretSchema.safeParse(parsed[name]).success)
    );
  } catch {
    return false;
  }
}

function declaredSecretNames(def: WorkflowDefinition): readonly string[] {
  return (def.workflow.inputs ?? [])
    .filter((decl) => decl.type === 'secret')
    .map((decl) => decl.name);
}

/** Run one step of a leg's teardown on its own: what it throws goes to `onFault`, and the step after it still runs. */
async function guarded(step: () => unknown, onFault: (cause: unknown) => void): Promise<void> {
  try {
    await step();
  } catch (cause) {
    onFault(cause);
  }
}

/** What a leg's drive found (see `RunHost.#runLeg`). */
interface LegResult {
  readonly facts: Omit<HostedRunTerminalInput, 'leg' | 'runId'> | undefined;
  readonly fault: unknown;
  /** A resume leg refused the run because another process holds it. */
  readonly takenOver: boolean;
}

/**
 * The departure the card is read from. `finishLeg` departed already (the handle answers the same fact again), so a departure that
 * THROWS here for a leg already known to be taken over must not rewrite that disposition into an unexpected end (M-Ho1): it is `undefined`
 * and the caller still has the disposition. For any other leg it is a fault, as before. Only a thrown error is excused: a departure that
 * answers `continue` is not acknowledged, which ADR-0139 §6 calls an internal fault whatever else is known of the leg, and it is thrown
 * so the leg's owner records it.
 */
async function readDeparture(
  handle: RunHandle,
  takenOver: boolean,
): Promise<Exclude<RunDeparture, { readonly kind: 'continue' }> | undefined> {
  let departure: RunDeparture;
  try {
    departure = await handle.depart();
  } catch (cause) {
    if (!takenOver) throw cause;
    return undefined;
  }
  if (departure.kind === 'continue')
    throw new CliError('internal', 'run departure was not acknowledged');
  return departure;
}

/** What a leg that ended with no usable disposition shows: the closed vocabulary of the terminal card. */
function unexpectedTerminal(runId: string): HostedRunTerminal {
  const id = displayRunId(runId);
  return Object.freeze({
    disposition: 'failed',
    safety: undefined,
    headline: `Run ${id} ended unexpectedly.`,
    remedy: 'Read the run in /workflows (History tab).',
    shellRemedy: `Read ${relaviumRunCommand('logs', runId)}.`,
  });
}

/**
 * The Home's leg manager: it runs a workflow, or answers a parked run, inside the Home
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1 to §3, §6, §7).
 *
 * - **One executing leg at a time, a fresh engine and a fresh owner for each.** A request while one prepares or
 *   executes is refused, never queued. `start` is single-flight: a second `start` while one is in flight returns
 *   the first one's promise and builds no second engine.
 * - **The Home's connection.** Every leg runs on `db`, through an opener whose `close` does nothing; this class
 *   never closes the Home's database, and the Home closes it only after {@link close} has settled.
 * - **A pause hands off.** A leg gets no gate prompter, so the run core takes the exit the shell's non-interactive
 *   path takes: it departs at the pause and the lease is handed back. {@link HostedLegEnd.handedOff} records it.
 * - **The disposition comes from the handle.** `finishLeg` departs; durability, the terminal error and the
 *   departure are read off the handle afterwards and described by `describeHostedRunTerminal`. No event stream
 *   is subscribed or consulted for it, because a stale `run:paused` can be the last event of a run another
 *   process owns.
 * - **Nothing reaches the terminal.** The leg's stderr and stdout go to {@link notices}.
 * - **Unattended, and one prompt.** The consent gate has no allowed digest, and its only prompt is the Home's consent card
 *   (`consent`): a server asks the per-machine grant log, then the card, or is refused. With no card wired it is refused.
 *   A masked secret is refused when blank.
 *
 * The leg's own epilogue does the teardown in the order the ADR fixes (the stream is joined, the run departs, the
 * MCP clients and their work close, the owner retires); {@link close} cancels the leg and waits for it.
 */
export class RunHost {
  readonly notices: RunNotices;
  readonly #invocation: CliInvocation | undefined;
  readonly #env: CliIo['env'];
  readonly #global: GlobalOptions;
  readonly #db: Db;
  /** The working directory as spelled: what a leg works in and loads its configuration from. */
  readonly #cwd: string;
  /** The directory whose runs this host answers, canonical ({@link RunHostOptions.projectRoot}). */
  readonly #projectRoot: string;
  readonly #homeDir: string;
  readonly #consent: ConsentPrompter | undefined;
  readonly #services: Services;
  readonly #renderer: RunHostOptions['renderer'];
  readonly #sweepMedia: typeof sweepHostMediaBestEffort;
  readonly #createResources: (lifetime: RunLifetime, io: CliIo) => RunResources;
  readonly #view = new HostedRunView();
  readonly #settleBoundMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  #launching: { readonly kind: LegKind; readonly promise: Promise<HostedLaunch> } | undefined;
  #active: ActiveLeg | undefined;
  #last: HostedLegEnd | undefined;
  /** The leg that ended with the most serious workflow safety fact so far (8, then 7, 5, 6): the Home's exit code carries it. */
  #safetyEnd: HostedLegEnd | undefined;
  /** The leg `close` gave up on: it may still be writing to the Home's database, which must then stay open. */
  #abandoned: { readonly runId: string | undefined } | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: RunHostOptions) {
    this.#invocation = options.invocation;
    this.#env = options.io.env;
    this.#global = options.global;
    this.#db = options.db;
    this.#cwd = options.global.cwd;
    this.#projectRoot = options.projectRoot ?? projectRootOf(options.global.cwd);
    this.#homeDir = options.homeDir;
    this.#consent = options.consent;
    this.notices = options.notices ?? new RunNotices();
    this.#renderer = options.renderer;
    this.#sweepMedia = options.sweepMedia ?? sweepHostMediaBestEffort;
    this.#settleBoundMs = options.settleBoundMs ?? HOSTED_LEG_SETTLE_BOUND_MS;
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.#createResources =
      options.createResources ?? ((lifetime, io) => new RunResources(lifetime, io));
    this.#services = {
      ...(options.buildEngine === undefined ? {} : { buildEngine: options.buildEngine }),
      ...(options.providers === undefined ? {} : { providers: options.providers }),
      ...(options.startMcpClient === undefined ? {} : { startMcpClient: options.startMcpClient }),
      ...(options.mcpSecretResolver === undefined
        ? {}
        : { mcpSecretResolver: options.mcpSecretResolver }),
    };
  }

  snapshot(): RunHostSnapshot {
    const leg = this.#active;
    return Object.freeze({
      launching: this.#launching !== undefined,
      active:
        leg === undefined
          ? undefined
          : Object.freeze({
              leg: leg.kind,
              runId: leg.runId,
              cancelling: leg.lifetime.stopped,
            }),
      last: this.#last,
    });
  }

  /**
   * Start a workflow. The latch is taken in this call, before any await, so two calls in one tick are one
   * start: the second returns the first's promise.
   */
  start(request: HostedStartRequest): Promise<HostedLaunch> {
    if (this.#launching?.kind === 'start') return this.#launching.promise;
    const turnedAway = this.#admission();
    if (turnedAway !== undefined) return turnedAway;
    return this.#launch('start', (context) => this.#acquireStart(request, context), request.signal);
  }

  /**
   * Answer a parked run on a fresh engine, or continue one that waits on media jobs only (the same leg, the same single flight, owner,
   * lease and teardown). A run recorded for another directory is refused before anything is registered or built: the Home never
   * re-anchors its workspace.
   */
  resume(request: HostedResumeRequest | HostedMediaResumeRequest): Promise<HostedLaunch> {
    const turnedAway = this.#admission();
    if (turnedAway !== undefined) return turnedAway;
    const otherProject = this.#otherProjectRefusal(request.runId);
    if (otherProject !== undefined) return Promise.resolve(otherProject);
    return this.#launch(
      'resume',
      (context) => this.#acquireResume(request, context),
      request.signal,
    );
  }

  /** Request the cooperative cancel of the leg that is preparing or executing. `false` when there is none. */
  cancel(): boolean {
    const leg = this.#active;
    if (leg === undefined) return false;
    leg.lifetime.stop();
    return true;
  }

  /**
   * Cancel the leg, wait for its teardown, and settle. The teardown order is the ADR's (§6): cancel the leg,
   * join its stream, `depart()` (it must return `detached` or `closed`), close the leg's MCP clients and work,
   * retire the owner. This never closes the Home's database: the caller closes it only after this settles.
   *
   * **It waits for a bounded time** ({@link HOSTED_LEG_SETTLE_BOUND_MS}, measured from this call). A leg that has not settled
   * by then is abandoned: it is recorded ({@link abandoned}), its owner stays registered and the invocation's finite-exit bound is
   * armed so the process ends. The caller must then NOT close the database, which the leg may still write to: it is left to the
   * process's exit.
   */
  close(): Promise<void> {
    this.#closing ??= this.#teardown();
    return this.#closing;
  }

  /** `close` gave up on a leg that had not settled: the Home's database must stay open for it. `false` until then. */
  get abandoned(): boolean {
    return this.#abandoned !== undefined;
  }

  /**
   * What the Home owes the person once its screen is restored ([ADR-0139] §6): one line for the leg that carried the most serious
   * safety fact, and one for a leg that had to be abandoned, each naming the run and the shell remedy. Empty when nothing needs saying.
   */
  exitFacts(): readonly HostedExitFact[] {
    const facts: HostedExitFact[] = [];
    const safety = this.#safetyEnd;
    if (safety !== undefined)
      facts.push(
        Object.freeze({
          kind: 'safety',
          runId: safety.runId,
          line: sanitizeInline(
            `${safety.terminal.headline} ${safety.terminal.shellRemedy ?? safety.terminal.remedy ?? ''}`.trim(),
          ),
        }),
      );
    const abandoned = this.#abandoned;
    if (abandoned !== undefined) {
      const raw = abandoned.runId;
      facts.push(
        Object.freeze({
          kind: 'abandoned',
          runId: raw === undefined ? '' : displayRunId(raw),
          line:
            raw === undefined
              ? 'A workflow run was still starting when the Home left. Its lease expires within a minute; read `relavium status`.'
              : `Run ${displayRunId(raw)} was still stopping when the Home left. Its lease expires within a minute and the next start settles it; read ${relaviumRunCommand('logs', raw)}.`,
        }),
      );
    }
    return facts;
  }

  async #teardown(): Promise<void> {
    this.#view.seal();
    this.#active?.lifetime.stop();
    let cancelBound: () => void = () => undefined;
    const bound = new Promise<false>((resolve) => {
      cancelBound = this.#schedule(() => resolve(false), this.#settleBoundMs);
    });
    /** Whether `work` settled before the bound ran out (a rejection counts: it is settled). */
    const settles = (work: Promise<unknown>): Promise<boolean> =>
      Promise.race([
        work.then(
          () => true,
          () => true,
        ),
        bound,
      ]);
    try {
      const launching = this.#launching;
      // The launch boundary: past it nothing is half-built, and a leg that started is stopped below.
      if (launching !== undefined && !(await settles(launching.promise))) {
        this.#abandon(this.#active);
        return;
      }
      const leg = this.#active;
      if (leg === undefined) return;
      leg.lifetime.stop();
      if (!(await settles(leg.done))) this.#abandon(leg);
    } finally {
      cancelBound();
    }
  }

  /**
   * Give up on a leg that ignored its cancel: say so in the record the Home prints, keep its owner registered (`cleanupFailed`
   * makes `finish` report `retained`) and arm the invocation's finite-exit bound, which is what ends the process. Nothing here
   * touches the database.
   */
  #abandon(leg: ActiveLeg | undefined): void {
    this.#abandoned = Object.freeze({ runId: leg?.runId });
    // The finite exit is armed FIRST: it is what ends the process, so a renderer whose `seal` throws cannot be the reason it never is.
    leg?.lifetime.cleanupFailed(
      new CliError('internal', 'A hosted run did not settle after it was asked to stop.'),
    );
    // The leg's frame loop is sealed with it: a leg that ignores its stop never reaches the epilogue that would seal it, and the loop would
    // keep repainting a view nobody reads until the process ends (`seal` is idempotent, and a renderer with no loop has none).
    leg?.renderer?.seal?.();
  }

  /** The reason a request cannot start now, as a settled launch; `undefined` when it may. */
  #admission(): Promise<HostedLaunch> | undefined {
    if (this.#closing !== undefined)
      return Promise.resolve(refused('closing', 'The Home is closing.'));
    if (this.#launching !== undefined || this.#active !== undefined) {
      const runId = this.#active?.runId;
      return Promise.resolve(
        refused(
          'busy',
          runId === undefined
            ? 'A run is already starting.'
            : `A run is already executing: ${sanitizeInline(runId)}.`,
        ),
      );
    }
    return undefined;
  }

  /** The refusal for a run recorded for another directory (or for none), before any work. */
  #otherProjectRefusal(runId: string): HostedLaunch | undefined {
    let recorded: string | null | undefined;
    try {
      recorded = loadRunSnapshot(this.#db, runId)?.projectRoot;
    } catch (cause) {
      return refused('rejected', this.#faultMessage(cause));
    }
    // A run that does not exist is the resume core's refusal to word; one recorded elsewhere is ours.
    if (recorded === undefined || isProjectRootHere(recorded, this.#projectRoot)) return undefined;
    // A run with no recorded root is not "another directory's": there is no directory to open the Home in, and the words must not say there is.
    // A relative root (`.`, written before roots were canonical) names no directory either: it is unrecorded, never this Home's.
    if (recordedProjectRoot(recorded) === undefined)
      return refused(
        'other_project',
        'This run was recorded without a project root, so the Home does not answer it. Answer it from the shell; `relavium status` shows how.',
      );
    return refused(
      'other_project',
      'This run belongs to another directory. Open Home there to answer it.',
    );
  }

  #launch(
    kind: LegKind,
    acquire: (context: LegContext) => Promise<Acquisition>,
    signal: AbortSignal | undefined,
  ): Promise<HostedLaunch> {
    const promise: Promise<HostedLaunch> = this.#hostLeg(kind, acquire, signal).finally(() => {
      if (this.#launching?.promise === promise) this.#launching = undefined;
    });
    this.#launching = { kind, promise };
    return promise;
  }

  async #hostLeg(
    kind: LegKind,
    acquire: (context: LegContext) => Promise<Acquisition>,
    signal: AbortSignal | undefined,
  ): Promise<HostedLaunch> {
    const invocation = this.#invocation;
    if (invocation === undefined)
      return refused('unavailable', 'This Home cannot run a workflow here.');
    let lifetime: HostedRunLifetime;
    try {
      // First, before any work is admitted: a termination request that arrives during preparation reaches it.
      lifetime = new HostedRunLifetime(invocation, this.#view);
    } catch (cause) {
      if (invocation.registry.termination === undefined) throw cause;
      return refused('closing', 'The Home is closing.');
    }
    this.notices.clear();
    const io = this.#legIo();
    const resources = this.#createResources(lifetime, io);
    const leg: ActiveLeg = {
      kind,
      lifetime,
      runId: undefined,
      renderer: undefined,
      done: Promise.resolve(),
    };
    this.#active = leg;
    // The flow that asked for this leg may be cancelled while the leg prepares (Esc or Ctrl+C on `Starting the run…`): the cancel
    // stops THIS leg's lifetime, so the connect and the consent card close and the run core's next checkpoint throws before the engine
    // takes the run. It governs the preparation only: the run core lets go of it at the leg's COMMIT POINT (`context.commit`, after its
    // last checkpoint and just before the engine starts or resumes the run, H1), and `finally` lets go of it on every path out.
    const untie = this.#stopWhenAborted(signal, lifetime);
    let acquired: Acquisition;
    try {
      acquired = await acquire({ lifetime, resources, io, commit: untie });
    } catch (cause) {
      const stopped = lifetime.isStoppedFailure(cause);
      if (!stopped) lifetime.failure(cause);
      await this.#release(leg, resources);
      if (!stopped) return refused('rejected', this.#faultMessage(cause));
      return refused('stopped', kind === 'resume' ? HOSTED_RESUME_CANCELLED : HOSTED_START_STOPPED);
    } finally {
      untie();
    }
    if ('settled' in acquired) {
      await this.#release(leg, resources);
      return { kind: 'settled', message: sanitizeUntrustedInline(acquired.settled) };
    }
    leg.runId = acquired.runId;
    const ended = this.#drive(leg, resources, acquired, io);
    leg.done = ended.then(() => undefined);
    return { kind: 'started', leg: kind, runId: acquired.runId, ended };
  }

  /** Stop `lifetime` when `signal` aborts (now, if it already has); returns what lets go of the signal. */
  #stopWhenAborted(signal: AbortSignal | undefined, lifetime: HostedRunLifetime): () => void {
    if (signal === undefined) return () => undefined;
    const stop = (): void => {
      lifetime.stop();
    };
    if (signal.aborted) {
      stop();
      return () => undefined;
    }
    signal.addEventListener('abort', stop, { once: true });
    return () => {
      signal.removeEventListener('abort', stop);
    };
  }

  /**
   * The words a fault is shown in: the user-facing message through the sanitize floor, with a config file named from the project or
   * from `~` and never by its absolute path (RUNCORE-3): a notice is drawn into a transcript that a screen share carries away.
   */
  #faultMessage(cause: unknown): string {
    const pathFree = faultForTranscript(cause, { cwd: this.#cwd, homeDir: this.#homeDir });
    return sanitizeUntrustedInline(toUserFacing(pathFree).message);
  }

  /** The teardown tail of a leg that never ran: what it acquired is released and its owner retires. */
  async #release(leg: ActiveLeg, resources: RunResources): Promise<void> {
    // Each release on its own: one that throws (a host bug: the one-use guards) is a release nobody acknowledged (`retained`, L5), and
    // must not skip the other, nor leave the host holding a leg that never ran.
    const unreleased = (cause: unknown): void => {
      leg.lifetime.cleanupFailed(cause);
    };
    try {
      await guarded(() => resources.releaseMcp(), unreleased);
      await guarded(() => resources.closeHistoryDb(), unreleased);
    } finally {
      await leg.lifetime.finish();
      if (this.#active === leg) this.#active = undefined;
    }
  }

  /**
   * Drive a leg to its end, in the background. It never rejects: a fault is recorded on the owner and on the
   * returned end, the cleanup tail always runs, and the leg is no longer active before `ended` settles, so a
   * caller that sees it end may start the next.
   */
  async #drive(
    leg: ActiveLeg,
    resources: RunResources,
    acquired: Acquired,
    io: CliIo,
  ): Promise<HostedLegEnd> {
    const { kind, lifetime } = leg;
    const { runId } = acquired;
    const result = await this.#runLeg(leg, acquired, io);
    const tailFault = await this.#cleanupTail(leg, resources);
    const retirement = await lifetime.finish();
    const terminal = this.#terminalOf({ kind, runId, ...result });
    const end: HostedLegEnd = Object.freeze({
      leg: kind,
      runId,
      terminal,
      handedOff: terminal.disposition === 'paused',
      retirement,
      // The leg's own fault first; a tail fault is named only when the leg had none (the terminal card still describes the run).
      fault:
        result.fault === undefined && tailFault === undefined
          ? undefined
          : this.#faultMessage(result.fault ?? tailFault),
    });
    this.#last = end;
    if (
      end.terminal.safety !== undefined &&
      safetyRank(end.terminal.safety) > safetyRank(this.#safetyEnd?.terminal.safety)
    )
      this.#safetyEnd = end;
    if (this.#active === leg) this.#active = undefined;
    return end;
  }

  /** What a leg's drive found: the facts its handle holds after the departure, or the fault that ended it (never both). */
  async #runLeg(leg: ActiveLeg, acquired: Acquired, io: CliIo): Promise<LegResult> {
    const { kind, lifetime } = leg;
    const { engine, handle, runId } = acquired;
    /** A resume leg refused the run because another process holds it: already the disposition, whatever follows. */
    let takenOver = false;
    try {
      const outcome: RunOutcome | undefined = await driveRun({
        lifetime,
        engine,
        handle,
        makeRenderer: (creation) => {
          creation.acknowledgeNoAcquisition();
          // Held on the leg, not in a local: the renderer is made inside this callback, which the compiler does not follow, and an
          // abandon (`#abandon`) must reach it from outside this method.
          const renderer = this.#renderer?.({ runId, leg: kind }) ?? NOOP_RENDERER;
          leg.renderer = renderer;
          return renderer;
        },
        // A pause hands off: with no prompter the drive departs at the pause (`shouldBreakOnPause`).
        makeGatePrompter: () => undefined,
        io,
        json: false,
      });
      takenOver = await this.#finish(leg, acquired, outcome, io);
      const departure = await readDeparture(handle, takenOver);
      if (departure === undefined) return { facts: undefined, fault: undefined, takenOver };
      // Read off the HANDLE, after the departure; never from a subscription or the last event.
      const facts = {
        outcome,
        durability: handle.durability(),
        terminalError: handle.terminalError(),
        departure,
      };
      return { facts, fault: undefined, takenOver };
    } catch (cause) {
      if (!lifetime.isStoppedFailure(cause)) lifetime.failure(cause);
      return { facts: undefined, fault: cause, takenOver };
    }
  }

  /** The shared epilogue of the leg. `true` when it refused the run as taken over, which is a disposition and not a fault. */
  async #finish(
    leg: ActiveLeg,
    acquired: Acquired,
    outcome: RunOutcome | undefined,
    io: CliIo,
  ): Promise<boolean> {
    try {
      await finishLeg({
        leg: leg.kind,
        noticeSurface: noticeSurfaceOf('home'), // the line a taken-over leg writes becomes a notice in the Home
        runId: acquired.runId,
        lifetime: leg.lifetime,
        io,
        json: false,
        handle: acquired.handle,
        outcome,
        db: acquired.db,
        mediaCasRoot: acquired.mediaCasRoot,
        mediaGcGraceMs: acquired.mediaGcGraceMs,
        sweepMedia: this.#sweepMedia,
      });
      return false;
    } catch (cause) {
      // A resume leg refuses a taken-over run with a typed error; here that is a disposition, not a fault.
      if (leg.kind === 'resume' && isCliError(cause) && cause.code === 'run_owned_elsewhere')
        return true;
      throw cause;
    }
  }

  /**
   * The cleanup tail: the leg's MCP clients and work, the renderer's frame loop, the (no-op) history close. EVERY step is guarded on its
   * own: a step that throws is a fault of the leg (recorded on the owner and returned for the end), and the steps after it still run,
   * so the leg is always no longer active, its owner always finishes and a later leg is never refused `busy` for a leg that is over
   * (P02a-2). Returns the first fault, if any.
   */
  async #cleanupTail(leg: ActiveLeg, resources: RunResources): Promise<unknown> {
    let fault: unknown;
    // An owned release that threw could not be acknowledged: `cleanupFailed` keeps the owner registered (`retained`) and arms the
    // Home's finite exit, as the resources' own unacknowledged closes do (L5). A renderer that cannot be sealed is a fault of the leg.
    const unreleased = (cause: unknown): void => {
      leg.lifetime.cleanupFailed(cause);
      fault ??= cause;
    };
    const faulted = (cause: unknown): void => {
      if (!leg.lifetime.isStoppedFailure(cause)) leg.lifetime.failure(cause);
      fault ??= cause;
    };
    await guarded(() => resources.releaseMcp(), unreleased);
    // A leg that failed, or that ended while the Home was closing, never reaches the renderer's own `finalize`: seal it here so the
    // frame loop it holds stops with the leg (`seal` is idempotent, and a renderer that has no loop has no `seal`).
    await guarded(() => leg.renderer?.seal?.(), faulted);
    await guarded(() => resources.closeHistoryDb(), unreleased);
    return fault;
  }

  /** What the Home shows of a leg that ended: the card the facts describe, or what is known of it when they could not be read. */
  #terminalOf(leg: {
    readonly kind: LegKind;
    readonly runId: string;
    readonly fault: unknown;
    readonly facts: Omit<HostedRunTerminalInput, 'leg' | 'runId'> | undefined;
    readonly takenOver: boolean;
  }): HostedRunTerminal {
    if (leg.fault === undefined && leg.facts !== undefined)
      return describeHostedRunTerminal({ leg: leg.kind, runId: leg.runId, ...leg.facts });
    // The run was taken over and its departure could not be read a second time: the disposition is still known.
    if (leg.fault === undefined && leg.takenOver) return takenOverTerminal(leg.runId);
    return unexpectedTerminal(leg.runId);
  }

  /** The io a leg writes to: nothing reaches the Home's terminal, every line becomes a notice. */
  #legIo(): CliIo {
    const notices = this.notices;
    return {
      writeOut: (text) => {
        notices.push(text);
      },
      writeErr: (text) => {
        notices.push(text);
      },
      writeOutAcknowledged: (text) => {
        notices.push(text);
        return Promise.resolve();
      },
      writeErrAcknowledged: (text) => {
        notices.push(text);
        return Promise.resolve();
      },
      env: this.#env,
      // Nothing about a leg is interactive: no prompt can open on it and no live view can take its output.
      stdoutIsTty: false,
      stdinIsTty: false,
      stdin: Readable.from([]),
    };
  }

  /** The Home's own history, over the Home's own connection, with a `close` that closes nothing. */
  #historyOverHome(
    workflow: WorkflowDefinition,
    homeDir: string,
    projectRoot: string,
  ): OpenedHistory {
    return {
      store: createRunHistoryStore(this.#db, {
        uuid: () => randomUUID(),
        now: () => Date.now(),
        projectRoot,
        workflow: {
          slug: workflow.workflow.id,
          name: workflow.workflow.name ?? workflow.workflow.id,
          definitionJson: JSON.stringify(workflow),
        },
      }),
      db: this.#db,
      terminalOutboxPath: terminalOutboxPath(homeDir),
      close: () => undefined,
    };
  }

  /**
   * The consent gate of a hosted leg: no digest a flag could have supplied, and the Home's card as its only prompt.
   *
   * The leg's `io` reports non-TTY (nothing about a leg is interactive), so the gate's own terminal check would refuse every
   * unapproved server. The card is not a terminal question: it is the Home's own native prompt, on the Home's own input owner. So
   * the gate is told its prompter is a card (`nativeCard`), and only when this host really has one: with none the gate cannot ask,
   * and a server nothing approved is refused with its digest.
   *
   * **A start and a resume are the same check.** The per-machine grant log is the only thing that approves a program, so a resumed
   * leg runs the gate exactly as a start does: a server this machine already approved starts without a question, and one it holds
   * no grant for (the grant was withdrawn, or the run was started on another machine, or by a script that passed a digest for one
   * invocation only) is asked about, through the same card. Skipping the check on a resume would let a parked run start a local
   * program nothing on this machine approved (the register's entry on the resumed hosted leg, ADR-0084 §1). The frozen tool grants
   * are a different thing (`preserveFrozenGrants`): they say which tools an approved server may be called for, never whether it
   * may be spawned.
   */
  #consentGate(context: LegContext, homeDir: string): StdioConsentGate {
    const card = this.#consent;
    return createConsentGate({
      io: context.io,
      global: this.#global,
      homeDir,
      allowedDigests: [],
      signal: context.lifetime.signal,
      ...(card === undefined ? {} : { prompt: card, nativeCard: true }),
    });
  }

  async #acquireStart(request: HostedStartRequest, context: LegContext): Promise<Acquisition> {
    const { lifetime, resources, io } = context;
    const prepared = await prepareRun(
      {
        workflow: request.workflow,
        rawInputs: request.rawInputs,
        ...(request.expectedSourceDigest === undefined
          ? {}
          : { expectedSourceDigest: request.expectedSourceDigest }),
        ...(request.expectedFsScope === undefined
          ? {}
          : { expectedFsScope: request.expectedFsScope }),
      },
      {
        io,
        // Every line a leg writes becomes a notice inside the TUI: its remedies name the Home's actions, never a shell command.
        noticeSurface: noticeSurfaceOf('home'),
        global: { cwd: this.#cwd, configPath: this.#global.configPath },
        // The same home a resume loads from, never the OS's: the host is always handed one.
        home: this.#homeDir,
        ...this.#services,
        openRunStore: (workflow, homeDir, projectRoot) =>
          this.#historyOverHome(workflow, homeDir, projectRoot),
      },
      {
        secretInputs: (def) => refuseBlankSecrets(request.secrets, declaredSecretNames(def)),
        consentGate: (homeDir) => this.#consentGate(context, homeDir),
        commit: context.commit,
      },
      lifetime,
      resources,
    );
    const handle = prepared.start();
    return {
      engine: prepared.engine,
      handle,
      runId: handle.runId,
      db: prepared.history?.db,
      mediaCasRoot: prepared.mediaCasRoot,
      mediaGcGraceMs: prepared.mediaGcGraceMs,
    };
  }

  async #acquireResume(
    request: HostedResumeRequest | HostedMediaResumeRequest,
    context: LegContext,
  ): Promise<Acquisition> {
    const { lifetime, resources, io } = context;
    const host = loadResolvedConfig({
      cwd: this.#cwd,
      configPath: this.#global.configPath,
      home: this.#homeDir,
    });
    // The Home may offer a secret port for every answer, because it cannot know what the run holds: it is asked only for a run
    // whose record carries a masked slot, and a run with none is resumed as the shell resumes it, with nothing to re-supply.
    const secretStdin =
      request.secrets !== undefined &&
      carriesMaskedSlots(loadRunSnapshot(this.#db, request.runId)?.inputJson ?? '');
    const resumed = await resumeRun(
      request.kind === 'media'
        ? { runId: request.runId, secretStdin, kind: 'media' }
        : {
            runId: request.runId,
            gate: request.gate,
            secretStdin,
            kind: request.kind,
            decision: request.decision,
          },
      {
        io,
        noticeSurface: noticeSurfaceOf('home'),
        global: { cwd: this.#cwd },
        ...this.#services,
      },
      { config: host.config, homeDir: host.homeDir },
      {
        openDb: () => ({ db: this.#db, close: () => undefined }),
        secretInputs: ({ maskedSlots }) => refuseBlankSecrets(request.secrets, maskedSlots),
        consentGate: (homeDir) => this.#consentGate(context, homeDir),
        commit: context.commit,
      },
      lifetime,
      resources,
    );
    if (resumed.kind === 'settled') return { settled: resumed.message };
    return {
      engine: resumed.engine,
      handle: resumed.handle,
      runId: request.runId,
      db: resumed.db,
      mediaCasRoot: resumed.mediaCasRoot,
      mediaGcGraceMs: host.config.mediaGcGraceMs,
    };
  }
}
