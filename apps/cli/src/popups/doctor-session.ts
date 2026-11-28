/**
 * The `/doctor` popup's state machine ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): what runs when, what each key does, and what
 * is kept between two openings. Loaded only when the person first opens the popup (`doctor-port.ts`); its words are `doctor-popup.ts`. What it
 * shares with the four report popups is written once: the work starter (`popup-work.ts`), the copy (`popup-copy.ts`), the scrub and the wrap
 * (`popup-text.ts`) and the phrases of a refused chord (`chord-refusal.ts`).
 *
 * **States.** idle (the quick tier is done) → armed (`[d]`: the confirmation line is being prepared) → confirming (the line is drawn and waits
 * for its chord) → running (the deep tier) → done; `[r]` runs the quick tier again from idle or done, and keeps the kept deep rows (labelled with
 * their age). A quick tier that FAILED is a state of its own (the checks step says so, with `[r]` and `[d]`, whatever lands after it: a deep result
 * included), never "no rows yet". Every step is a step of ONE popup, and every result carries the popup's run: a result for a popup that is
 * closed or replaced lands nowhere (`PopupContext.setContent`).
 *
 * **The quick tier reads off the render.** Each probe (the keychain's reachability, the configuration, the global artifacts) and each provider's
 * key PRESENCE (`availability` or `hasKey`, never a key value) runs in the work the popup starts (`startPopupWork`), one at a time with the event loop given back
 * between two, and the presence reads stop at {@link DOCTOR_PRESENCE_BOUND_MS}: a keychain that is locked or asks for access blocks the loop for
 * that read only, never a frame. Nothing here runs while the popup is drawn.
 *
 * **The deep tier is a consent.** `[d]` arms the line: the providers whose key is present and whose pinned destination is a known origin are
 * read ONCE, then FROZEN with their origins, and the line names those origins. `Ctrl+Y` answers it only through the host's chord guard
 * (`popup-host.ts`); the run is then given exactly the frozen targets (`runConsentedProviderChecks`), which refuses an endpoint changed since and
 * never reads a provider that was not named. Disarming the line forgets them.
 *
 * **One deep run per host.** The run is the host's (kept under the port's `scope`), with its own abort controller chained to the work owner's
 * signal; closing the popup (`Esc` on the running step, `Ctrl+C`, a sheet, the host ending) aborts it, and its abort reaches each request. The
 * run stays IN FLIGHT until its report has settled and every request it retained has settled too, so a provider that ignores the abort cannot
 * be asked a second time by a reopened popup: `[d]` then says the last check is still stopping. A COMPLETED result is kept for the process and
 * shown again, with its age; an aborted one is never kept.
 *
 * **The checks step's letters follow what it shows.** `[r]` and `[d]` are always listed; `[c] copy` only while the rows are shown (never while
 * the step loads or says the checks could not run: a copy of that would be a report of nothing). The deep rows' age is read when the rows are
 * built, which is when a result lands and each time the popup comes back to the checks step, so it is the age at the moment the person looks.
 * `[r]` and `[c]` belong to the checks step: on a row's detail they do nothing, and `Esc` goes back to the checks, where they work.
 *
 * **MCP is only reported.** In a chat the deep tier adds the session's MCP rows from the probes' read-only report (the bound agent's declared
 * servers and the tools the manager skipped): nothing connects, spawns or contacts a server. The Home has no session, so it has no MCP rows.
 */

import type { ProviderId } from '@relavium/llm';

import { runConsentedProviderChecks, type ConsentTarget } from '../chat/doctor-deep.js';
import {
  checkConfig,
  checkKeychain,
  checkTools,
  warnCheck,
  type DoctorCheck,
} from '../chat/doctor.js';
import {
  KNOWN_PROVIDER_IDS,
  providerEndpointOrigin,
  type ProviderResolver,
} from '../engine/providers.js';
import { tryCall } from '../process/attempt.js';
import { keyToken } from '../render/tui/legend.js';
import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import {
  checksContent,
  consentContent,
  detailContent,
  detailEnter,
  doctorChecksControls,
  doctorCopyText,
  doctorRowId,
  doctorSpec,
  DOCTOR_LOADING,
  DOCTOR_STEP,
  providerKeysCheck,
  quickFailedContent,
  remedyOf,
  type DoctorTier,
  type DoctorView,
} from './doctor-popup.js';
import type { DoctorOpenRequest } from './doctor-port.js';
import type { PopupContent } from './frame-model.js';
import { copyPopupText } from './popup-copy.js';
import type { ChordRefusal, PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import { macrotask, startPopupWork } from './popup-work.js';

/** How long the presence reads of one check may take before the rest are not read (each read is synchronous: a keychain may prompt). */
export const DOCTOR_PRESENCE_BOUND_MS = 2000;

/** A completed deep result, kept for the process under the host's scope. */
interface KeptDeep {
  readonly at: number;
  readonly providers: readonly DoctorCheck[];
  /** A chat's MCP rows, shown again only in the session that reported them. */
  readonly mcp: { readonly key: string; readonly checks: readonly DoctorCheck[] } | undefined;
}

/** The host's deep run: in flight until its report AND every request it retained have settled. */
interface DeepRun {
  readonly controller: AbortController;
  /** The popup run that started it: closing that popup aborts it. */
  readonly owner: number;
  producers: number;
  reported: boolean;
}

interface ScopeState {
  kept: KeptDeep | undefined;
  run: DeepRun | undefined;
}

/** One state per host: a WeakMap, so a host that is gone takes its state with it. */
const SCOPES = new WeakMap<object, ScopeState>();

function scopeOf(key: object): ScopeState {
  let state = SCOPES.get(key);
  if (state === undefined) {
    state = { kept: undefined, run: undefined };
    SCOPES.set(key, state);
  }
  return state;
}

/** Whether the host's deep run is still in flight (its report or one of its requests has not settled). For the host's tests. */
export function deepRunInFlight(scope: object): boolean {
  return SCOPES.get(scope)?.run !== undefined;
}

/** A provider's key presence, a boolean and never a value; `undefined` for a resolver that can only read the value (it is not asked). */
function presenceOf(resolver: ProviderResolver, id: ProviderId): boolean | undefined {
  if (resolver.availability !== undefined) return resolver.availability(id).status === 'usable';
  if (resolver.hasKey !== undefined) return resolver.hasKey(id);
  return undefined;
}

/**
 * What the person is told when a `Ctrl+Y` did not count (it disarmed the line): the reason in a few words (`chord-refusal.ts`, the one table of
 * them), what did not happen (nothing was sent) and what asks again. At most `POPUP_NOTICE_MAX_COLUMNS`, the room a notification has beside the way
 * back in the legend row of a popup at the smallest terminal, so it is never cut. Exported for the tests only (`chord-refusal.test.ts` pins the
 * sentence by literal beside the cost release's); no host calls it.
 */
export function chordRefusedText(reason: ChordRefusal): string {
  return `Nothing was sent: ${CHORD_REFUSAL_PHRASE[reason]}. ${keyToken('d')} asks again.`;
}

/** What the line says while the host's last deep run is still stopping: nothing new can be sent yet. */
export const STILL_STOPPING = 'The last deep check is still stopping, so nothing new is sent yet.';

/**
 * Open the doctor popup over `request.host` (see the module header). Refused opens are said by the host in one notification and return its
 * refusal; an opened popup starts the quick tier at once, and a typed `/doctor --deep` also arms the line.
 */
export function openDoctorPopup(request: DoctorOpenRequest): PopupOpenResult {
  const { host, port } = request;
  const now = request.now ?? ((): number => performance.now());
  const pause = request.yieldToLoop ?? macrotask;
  const scope = scopeOf(port.scope);
  const resolver = port.probes.providers;
  const remedies = port.openRemedy !== undefined && port.surface === 'home';

  // What THIS popup holds; nothing of it outlives the popup but the scope's kept result.
  let popupRun = 0;
  let quick: readonly DoctorCheck[] | undefined;
  let quickProgress: string = DOCTOR_LOADING.quick;
  let quickGeneration = 0;
  let deepRunning = false;
  /** Whether the quick tier's last run failed: the checks step then says so (with `[r]`), whatever else lands, until a run is started again. */
  let quickFailed = false;
  /** Whether the checks step shows the rows now (and so has a report to copy), as opposed to loading or an error. */
  let rowsShown = false;
  let arming = 0;
  let armed:
    | { readonly id: number; readonly targets: readonly ConsentTarget[] | undefined }
    | undefined;
  let detail: { readonly tier: DoctorTier; readonly check: DoctorCheck } | undefined;

  const view = (): DoctorView => {
    const kept = scope.kept;
    if (kept === undefined) return { quick: quick ?? [] };
    const mcp = kept.mcp?.key === port.resultKey ? kept.mcp.checks : [];
    return {
      quick: quick ?? [],
      deep: { checks: [...kept.providers, ...mcp], ageMs: now() - kept.at },
    };
  };

  /**
   * Put `content` on the checks step with the letters it answers to: `[c]` only while the rows are shown (a loading step or an error has no
   * report, and a copy of one would be a report of nothing).
   */
  const showChecks = (context: PopupContext, content: PopupContent): void => {
    rowsShown = content.kind === 'list';
    context.setContent(DOCTOR_STEP.checks, content, doctorChecksControls(rowsShown));
  };

  /**
   * The checks step, from what is known now: the deep run's wait, the quick tier's failure, its wait, or the rows (the deep rows' age is read
   * now). A failed quick tier is a state of its own, never "no rows yet": it is said (with `[r]` and `[d]`) while a deep run lands or fails, and
   * the kept deep result is not lost, it is shown with the rows once `[r]` succeeds.
   */
  const refresh = (context: PopupContext): void => {
    if (deepRunning) showChecks(context, { kind: 'loading', what: DOCTOR_LOADING.deep });
    else if (quickFailed) showChecks(context, quickFailedContent());
    else if (quick === undefined) showChecks(context, { kind: 'loading', what: quickProgress });
    else showChecks(context, checksContent(view()));
  };

  /** Each provider's key presence, read one at a time off the render, until the bound; a key past it falls back on the host's sample. */
  const readPresence = async (
    live: () => boolean,
    useSample: boolean,
    progress: (done: number) => void,
  ): Promise<
    | {
        readonly present: ReadonlyMap<ProviderId, boolean>;
        readonly unchecked: readonly ProviderId[];
      }
    | undefined
  > => {
    const present = new Map<ProviderId, boolean>();
    const unchecked: ProviderId[] = [];
    const sample = useSample ? port.cachedKeys?.() : undefined;
    const started = now();
    for (const [index, id] of KNOWN_PROVIDER_IDS.entries()) {
      progress(index);
      await pause();
      if (!live()) return undefined;
      let value: boolean | undefined;
      if (resolver !== undefined && now() - started <= DOCTOR_PRESENCE_BOUND_MS) {
        try {
          value = presenceOf(resolver, id);
        } catch {
          value = undefined; // a read that failed is not a key
        }
      }
      value ??= sample?.find((entry) => entry.id === id)?.usable;
      if (value === undefined) unchecked.push(id);
      else present.set(id, value);
    }
    return { present, unchecked };
  };

  /** Run the quick tier again (it keeps the kept deep rows). */
  const runQuick = (context: PopupContext): void => {
    quickGeneration += 1;
    const generation = quickGeneration;
    const live = (): boolean => !context.signal.aborted && quickGeneration === generation;
    quick = undefined;
    quickFailed = false;
    quickProgress = DOCTOR_LOADING.quick;
    refresh(context);
    const operation = async (): Promise<void> => {
      const checks: DoctorCheck[] = [];
      await pause();
      if (!live()) return;
      checks.push(checkKeychain(port.probes.keychain));
      await pause();
      if (!live()) return;
      checks.push(checkConfig(port.probes.config));
      checks.push(checkTools(port.probes.toolHost));
      await pause();
      if (!live()) return;
      const artifacts = port.probes.globalArtifacts?.();
      if (artifacts !== undefined)
        checks.push(warnCheck('global-artifacts', 'global artifacts', artifacts));
      const keys = await readPresence(live, true, (done) => {
        quickProgress = DOCTOR_LOADING.keys(done, KNOWN_PROVIDER_IDS.length);
        if (live()) refresh(context);
      });
      if (keys === undefined || !live()) return;
      checks.push(providerKeysCheck(keys.present, keys.unchecked));
      quick = checks;
      refresh(context);
    };
    startPopupWork(port.workOwner, operation, () => {
      if (!live()) return;
      quick = undefined;
      quickFailed = true;
      refresh(context);
    });
  };

  /** Arm the line: read which providers have a key and where each would send it, freeze them, and say so. */
  const armLine = (context: PopupContext): void => {
    arming += 1;
    const id = arming;
    armed = { id, targets: undefined };
    context.goToStep(DOCTOR_STEP.line);
    if (scope.run !== undefined) {
      // One deep run per host: the last one has not finished stopping, so this line confirms nothing.
      context.setContent(DOCTOR_STEP.line, {
        kind: 'empty',
        what: STILL_STOPPING,
        next: `${keyToken('Esc')} goes back; try again in a moment.`,
      });
      return;
    }
    context.setContent(DOCTOR_STEP.line, { kind: 'loading', what: DOCTOR_LOADING.line });
    const live = (): boolean => !context.signal.aborted && armed?.id === id;
    void readPresence(live, false, () => undefined).then(
      (keys) => {
        if (keys === undefined || !live()) return;
        const targets: ConsentTarget[] = [];
        const notNamed: ProviderId[] = [...keys.unchecked];
        for (const providerId of KNOWN_PROVIDER_IDS) {
          if (keys.present.get(providerId) !== true) continue;
          const origin =
            resolver === undefined ? undefined : providerEndpointOrigin(resolver, providerId);
          if (origin === undefined) notNamed.push(providerId);
          else targets.push({ providerId, origin });
        }
        const content = consentContent(
          targets,
          notNamed,
          port.surface,
          host.getSnapshot().placement,
        );
        // Only a line that was drawn whole can be answered: one that is refused (it does not fit the page) names nothing to confirm.
        armed = { id, targets: content.kind === 'report' ? targets : [] };
        context.setContent(DOCTOR_STEP.line, content);
      },
      (cause: unknown) => {
        port.workOwner?.failure(cause);
        if (live())
          context.setContent(DOCTOR_STEP.line, {
            kind: 'error',
            what: 'The providers could not be read.',
            next: `${keyToken('Esc')} goes back.`,
          });
      },
    );
  };

  /** The run the line consented to: exactly its targets, owned by the host, chained to the work owner, aborted when this popup closes. */
  const startDeep = (context: PopupContext, targets: readonly ConsentTarget[]): void => {
    if (resolver === undefined || scope.run !== undefined) return;
    const owner = port.workOwner;
    const controller = new AbortController();
    const run: DeepRun = { controller, owner: popupRun, producers: 0, reported: false };
    scope.run = run;
    const settle = (): void => {
      if (run.reported && run.producers === 0 && scope.run === run) scope.run = undefined;
    };
    const stopWithOwner = (): void => {
      controller.abort();
    };
    owner?.signal.addEventListener('abort', stopWithOwner, { once: true });
    if (owner?.signal.aborted === true) controller.abort();
    // Every request the run makes is counted until it settles, whatever its report says: one that ignores the abort keeps the run in flight.
    const retainWork = <T>(factory: () => Promise<T>): Promise<T> => {
      run.producers += 1;
      const done = (): void => {
        run.producers -= 1;
        settle();
      };
      const started = tryCall(() =>
        owner === undefined ? factory() : owner.work.retainWork(factory),
      );
      if (!started.ok) {
        done();
        throw started.cause;
      }
      const raw = started.value;
      raw.then(done, done);
      return raw;
    };
    deepRunning = true;
    refresh(context);
    const operation = async (): Promise<{
      readonly providers: readonly DoctorCheck[];
      readonly mcp: readonly DoctorCheck[] | undefined;
    }> => {
      const providers = await runConsentedProviderChecks(targets, {
        resolver,
        lifecycle: {
          signal: controller.signal,
          work: { retainWork },
          assertAdmitting: owner?.assertAdmitting ?? ((): void => undefined),
        },
      });
      // The session's MCP servers are REPORTED from what the build already resolved; nothing is contacted (the Home has none).
      const mcp = port.surface === 'home' ? undefined : await port.probes.deepMcp?.();
      return { providers, mcp };
    };
    const finish = (): void => {
      run.reported = true;
      owner?.signal.removeEventListener('abort', stopWithOwner);
      settle();
    };
    const started = tryCall(() => (owner === undefined ? operation() : owner.enter(operation)));
    if (!started.ok) {
      finish();
      owner?.failure(started.cause);
      deepRunning = false;
      refresh(context);
      return;
    }
    const pending = started.value;
    pending
      .then(
        (result) => {
          finish();
          // An aborted run lands nowhere and is never kept: what it says was not what the person waited for.
          if (controller.signal.aborted) return;
          scope.kept = {
            at: now(),
            providers: result.providers,
            mcp: result.mcp === undefined ? undefined : { key: port.resultKey, checks: result.mcp },
          };
          deepRunning = false;
          refresh(context);
        },
        (cause: unknown) => {
          finish();
          owner?.failure(cause);
          if (controller.signal.aborted) return;
          deepRunning = false;
          showChecks(context, {
            kind: 'error',
            what: 'The deep check could not run.',
            next: `${keyToken('r')} runs the quick check again.`,
          });
        },
      )
      // A fault while the result lands (a listener of the popup that throws) is the owner's, never an unhandled rejection.
      .catch((cause: unknown) => {
        owner?.failure(cause);
      });
  };

  /** The check a row of the checks step shows (a quick row, or a kept deep row). */
  const checkOf = (
    rowId: string,
  ): { readonly tier: DoctorTier; readonly check: DoctorCheck } | undefined => {
    const shown = view();
    const quickHit = shown.quick.find((check) => doctorRowId('quick', check) === rowId);
    if (quickHit !== undefined) return { tier: 'quick', check: quickHit };
    const deepHit = shown.deep?.checks.find((check) => doctorRowId('deep', check) === rowId);
    return deepHit === undefined ? undefined : { tier: 'deep', check: deepHit };
  };

  const copy = (context: PopupContext): void => {
    // The report is what the checks step shows: while it loads, or says the checks could not run, there is none (a kept deep result alone is
    // not the report either).
    if (!rowsShown) return;
    copyPopupText(context, port, 'Doctor', doctorCopyText(view(), port.plainGlyphs === true));
  };

  const handlers: PopupHandlers = {
    enter: (context, row) => {
      const step = context.stepIndex();
      if (step === DOCTOR_STEP.checks && row !== undefined) {
        const found = checkOf(row.id);
        if (found === undefined) return;
        detail = found;
        const ageMs =
          found.tier === 'deep' && scope.kept !== undefined ? now() - scope.kept.at : undefined;
        // ONE decision for the row shown: its words say `Press Enter …` and its legend names `Enter` only where a remedy opens from it, and
        // a healthy row's `Enter` answers nothing (no letter either: `[r]` and `[c]` belong to the checks step).
        const remedy = remedies ? remedyOf(found.tier, found.check, port.surface) : undefined;
        context.setContent(
          DOCTOR_STEP.detail,
          detailContent(found.tier, found.check, port.surface, {
            deepAgeMs: ageMs,
            offered: remedy !== undefined,
          }),
          [],
          detailEnter(remedy),
        );
        context.goToStep(DOCTOR_STEP.detail);
        return;
      }
      // The seam for the provider popup: a remedy that exists on this surface is handed to the host (the Home closes the doctor and opens `/providers`).
      if (step === DOCTOR_STEP.detail && detail !== undefined) {
        const remedy = remedyOf(detail.tier, detail.check, port.surface);
        if (remedy !== undefined) port.openRemedy?.(remedy, context);
      }
    },
    control: (context, key) => {
      if (context.stepIndex() !== DOCTOR_STEP.checks || deepRunning) return;
      if (key === 'r') runQuick(context);
      else if (key === 'd') armLine(context);
      else if (key === 'c') copy(context);
    },
    chord: (context) => {
      const line = armed;
      armed = undefined;
      if (line?.targets === undefined || line.targets.length === 0) return;
      context.goToStep(DOCTOR_STEP.checks);
      startDeep(context, line.targets);
    },
    chordRefused: (context, reason) => {
      armed = undefined;
      context.notify(chordRefusedText(reason));
    },
    stepChanged: (context, from, to) => {
      // Leaving the line forgets what it named: a later `[d]` reads the providers again.
      if (from === DOCTOR_STEP.line) armed = undefined;
      // Back on the checks, the deep rows' age is read again (it was the age when they were last built, however long ago): no timer, only
      // the moment the person looks. A step that is loading or failed has no age to show: it is left as it is (a failure is not turned back into a wait).
      if (to === DOCTOR_STEP.checks && rowsShown) refresh(context);
    },
    closed: () => {
      armed = undefined;
      // `Esc` on the running step, `Ctrl+C`, a sheet, the host ending: the run this popup started is aborted, and its abort reaches the requests.
      if (scope.run?.owner === popupRun) scope.run.controller.abort();
    },
  };

  const opened = host.openForUser(doctorSpec(request.origin, request.deep), handlers);
  if (!opened.opened) return opened;
  popupRun = opened.runId;
  runQuick(opened.context);
  if (request.deep) armLine(opened.context);
  return opened;
}
