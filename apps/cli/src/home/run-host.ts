import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { RunHandle, WorkflowDefinition, WorkflowEngine } from '@relavium/core';
import { createRunHistoryStore, loadRunSnapshot, type Db } from '@relavium/db';
import { MaskedSecretSchema, type GateDecision } from '@relavium/shared';

import { driveRun, type RunOutcome } from '../commands/drive.js';
import { loadResolvedConfig } from '../config/load.js';
import { createConsentGate, type ConsentPrompter } from '../engine/mcp-consent-gate.js';
import type { StdioConsentGate } from '../engine/mcp-servers.js';
import { sweepHostMediaBestEffort } from '../engine/media-gc.js';
import { terminalOutboxPath, type OpenedHistory } from '../history/open.js';
import { CliError, isCliError, toUserFacing } from '../process/errors.js';
import type { CliInvocation } from '../process/invocation.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { HOSTED_RUN_EXIT_SETTLE_MS } from '../render/tui/tui-constants.js';
import type { RunJobControl } from '../render/run-job-control.js';
import { sanitizeInline, sanitizeUntrustedInline } from '../render/sanitize.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import { finishLeg, type LegKind } from '../run-core/finish-leg.js';
import { prepareRun, type PrepareRunDeps } from '../run-core/prepare-run.js';
import type { RunLifetime, RunTerminalView } from '../run-core/run-lifetime.js';
import { resumeRun } from '../run-core/resume-run.js';
import { RunResources } from '../run-core/run-resources.js';
import type { RendererCreationOwner } from '../commands/workflow-terminal.js';
import { HostedRunLifetime, type HostedLegRetirement } from './hosted-run-lifetime.js';
import {
  describeHostedRunTerminal,
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
  /** The operator home override of the Home's own config load (tests); the run core reads its own. */
  readonly homeDir?: string | undefined;
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

/** The registry's order of the workflow safety facts (its sticky priority: 8, then 7, 5, 6); no fact ranks below every one. */
function safetyRank(safety: HostedRunTerminal['safety']): number {
  switch (safety) {
    case 8:
      return 4;
    case 7:
      return 3;
    case 5:
      return 2;
    case 6:
      return 1;
    default:
      return 0;
  }
}

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

/** What a leg that ended with no usable disposition shows: the closed vocabulary of the terminal card. */
function unexpectedTerminal(runId: string): HostedRunTerminal {
  const id = sanitizeInline(runId);
  return Object.freeze({
    disposition: 'failed',
    safety: undefined,
    headline: `Run ${id} ended unexpectedly.`,
    remedy: `Read \`relavium logs ${id}\`.`,
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
  readonly #projectRoot: string;
  readonly #homeDir: string | undefined;
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
    this.#projectRoot = options.global.cwd;
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
    return this.#launch('start', (context) => this.#acquireStart(request, context));
  }

  /**
   * Answer a parked run on a fresh engine. A run recorded for another directory is refused before anything is
   * registered or built: the Home never re-anchors its workspace.
   */
  resume(request: HostedResumeRequest): Promise<HostedLaunch> {
    const turnedAway = this.#admission();
    if (turnedAway !== undefined) return turnedAway;
    const otherProject = this.#otherProjectRefusal(request.runId);
    if (otherProject !== undefined) return Promise.resolve(otherProject);
    return this.#launch('resume', (context) => this.#acquireResume(request, context));
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
            `${safety.terminal.headline} ${safety.terminal.remedy ?? ''}`.trim(),
          ),
        }),
      );
    const abandoned = this.#abandoned;
    if (abandoned !== undefined) {
      const id = abandoned.runId === undefined ? undefined : sanitizeInline(abandoned.runId);
      facts.push(
        Object.freeze({
          kind: 'abandoned',
          runId: id ?? '',
          line:
            id === undefined
              ? 'A workflow run was still starting when the Home left. Its lease expires within a minute; read `relavium status`.'
              : `Run ${id} was still stopping when the Home left. Its lease expires within a minute and the next start settles it; read \`relavium logs ${id}\`.`,
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
    // The leg's frame loop is sealed with it: a leg that ignores its stop never reaches the epilogue that would seal it, and the loop would
    // keep repainting a view nobody reads until the process ends (`seal` is idempotent, and a renderer with no loop has none).
    leg?.renderer?.seal?.();
    leg?.lifetime.cleanupFailed(
      new CliError('internal', 'A hosted run did not settle after it was asked to stop.'),
    );
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
      return refused('rejected', sanitizeUntrustedInline(toUserFacing(cause).message));
    }
    // A run that does not exist is the resume core's refusal to word; one recorded elsewhere is ours.
    if (recorded === undefined || recorded === this.#projectRoot) return undefined;
    // A run with no recorded root is not "another directory's": there is no directory to open the Home in, and the words must not say there is.
    if (recorded === null)
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
  ): Promise<HostedLaunch> {
    const promise: Promise<HostedLaunch> = this.#hostLeg(kind, acquire).finally(() => {
      if (this.#launching?.promise === promise) this.#launching = undefined;
    });
    this.#launching = { kind, promise };
    return promise;
  }

  async #hostLeg(
    kind: LegKind,
    acquire: (context: LegContext) => Promise<Acquisition>,
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
    let acquired: Acquisition;
    try {
      acquired = await acquire({ lifetime, resources, io });
    } catch (cause) {
      const stopped = lifetime.isStoppedFailure(cause);
      if (!stopped) lifetime.failure(cause);
      await this.#release(leg, resources);
      return stopped
        ? refused('stopped', 'The run was stopped before it started.')
        : refused('rejected', sanitizeUntrustedInline(toUserFacing(cause).message));
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

  /** The teardown tail of a leg that never ran: what it acquired is released and its owner retires. */
  async #release(leg: ActiveLeg, resources: RunResources): Promise<void> {
    await resources.releaseMcp();
    resources.closeHistoryDb();
    await leg.lifetime.finish();
    if (this.#active === leg) this.#active = undefined;
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
    const { engine, handle, runId } = acquired;
    let facts: Omit<HostedRunTerminalInput, 'leg' | 'runId'> | undefined;
    let fault: unknown;
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
      try {
        await finishLeg({
          leg: kind,
          runId,
          lifetime,
          io,
          json: false,
          handle,
          outcome,
          db: acquired.db,
          mediaCasRoot: acquired.mediaCasRoot,
          mediaGcGraceMs: acquired.mediaGcGraceMs,
          sweepMedia: this.#sweepMedia,
        });
      } catch (cause) {
        // A resume leg refuses a taken-over run with a typed error; here that is a disposition, not a fault.
        if (!(kind === 'resume' && isCliError(cause) && cause.code === 'run_owned_elsewhere'))
          throw cause;
      }
      const departure = await handle.depart();
      if (departure.kind === 'continue')
        throw new CliError('internal', 'run departure was not acknowledged');
      // Read off the HANDLE, after the departure; never from a subscription or the last event.
      facts = {
        outcome,
        durability: handle.durability(),
        terminalError: handle.terminalError(),
        departure,
      };
    } catch (cause) {
      if (!lifetime.isStoppedFailure(cause)) lifetime.failure(cause);
      fault = cause;
    }
    // The cleanup tail: the leg's MCP clients and work, the (no-op) history close, and only then the owner.
    await resources.releaseMcp();
    // A leg that failed, or that ended while the Home was closing, never reaches the renderer's own `finalize`: seal it here so the
    // frame loop it holds stops with the leg (`seal` is idempotent, and a renderer that has no loop has no `seal`).
    leg.renderer?.seal?.();
    resources.closeHistoryDb();
    const retirement = await lifetime.finish();
    const terminal =
      fault === undefined && facts !== undefined
        ? describeHostedRunTerminal({ leg: kind, runId, ...facts })
        : unexpectedTerminal(runId);
    const end: HostedLegEnd = Object.freeze({
      leg: kind,
      runId,
      terminal,
      handedOff: terminal.disposition === 'paused',
      retirement,
      fault: fault === undefined ? undefined : sanitizeUntrustedInline(toUserFacing(fault).message),
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
      { workflow: request.workflow, rawInputs: request.rawInputs },
      {
        io,
        global: { cwd: this.#projectRoot, configPath: this.#global.configPath },
        // The same home a resume loads from: with none injected the load falls back to the OS home, as the shell's does.
        ...(this.#homeDir === undefined ? {} : { home: this.#homeDir }),
        ...this.#services,
        openRunStore: (workflow, homeDir, projectRoot) =>
          this.#historyOverHome(workflow, homeDir, projectRoot),
      },
      {
        secretInputs: (def) => refuseBlankSecrets(request.secrets, declaredSecretNames(def)),
        consentGate: (homeDir) => this.#consentGate(context, homeDir),
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

  async #acquireResume(request: HostedResumeRequest, context: LegContext): Promise<Acquisition> {
    const { lifetime, resources, io } = context;
    const host = loadResolvedConfig({
      cwd: this.#projectRoot,
      configPath: this.#global.configPath,
      ...(this.#homeDir === undefined ? {} : { home: this.#homeDir }),
    });
    const resumed = await resumeRun(
      {
        runId: request.runId,
        gate: request.gate,
        // The Home may offer a secret port for every answer, because it cannot know what the run holds: it is asked only for a run
        // whose record carries a masked slot, and a run with none is resumed as the shell resumes it, with nothing to re-supply.
        secretStdin:
          request.secrets !== undefined &&
          carriesMaskedSlots(loadRunSnapshot(this.#db, request.runId)?.inputJson ?? ''),
        kind: request.kind,
        decision: request.decision,
      },
      { io, global: { cwd: this.#projectRoot }, ...this.#services },
      { config: host.config, homeDir: host.homeDir },
      {
        openDb: () => ({ db: this.#db, close: () => undefined }),
        secretInputs: ({ maskedSlots }) => refuseBlankSecrets(request.secrets, maskedSlots),
        consentGate: (homeDir) => this.#consentGate(context, homeDir),
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
