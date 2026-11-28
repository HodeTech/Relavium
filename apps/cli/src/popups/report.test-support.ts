/**
 * Test support for the four report popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10): a popup host on a manual monotonic clock (the doctor's rig), a report opened on it with the work's pause made a microtask, and ports over
 * fakes whose every call is counted. Nothing here reaches a database, a disk, a keychain or a network.
 */

import type { SessionCostRow } from '@relavium/db';
import { vi } from 'vitest';

import type { CatalogEntry } from '../workflows/catalog.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import type { PopupContent } from './frame-model.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost, type PopupOpenResult } from './popup-host.js';
import { currentStep, type PopupKey } from './popup-reducer.js';
import { manualClock } from './doctor.test-support.js';
import { openReportPopup } from './report-session.js';
import type {
  CostPort,
  CostReading,
  CostRelease,
  ParsedReportLine,
  ReportsPort,
  WorkflowsReading,
} from './report-port.js';

export { manualClock, settleWork } from './doctor.test-support.js';

export const COMPLETE = { unverified: false, pendingInvocations: 0, unknownCalls: 0 } as const;

/** A model's row of the session's cost. */
export const costRow = (over: Partial<SessionCostRow> & { model: string }): SessionCostRow => ({
  modelCatalogId: undefined,
  inputTokens: 100,
  outputTokens: 200,
  conservativeMicrocents: 0,
  costMicrocents: 0,
  callCount: 1,
  unpricedCalls: 0,
  isLegacy: false,
  ...over,
});

/** A reading of the session's spend: `held` micro-cents held in the rows and, when `live` is given, in the live governor. */
export function costReading(
  held = 0,
  live: { readonly microcents: number; readonly durabilityBroken?: boolean } | undefined = held > 0
    ? { microcents: held }
    : undefined,
  rows: readonly SessionCostRow[] = [
    costRow({
      model: 'claude-opus-4-8',
      costMicrocents: 12_000,
      callCount: 3,
      conservativeMicrocents: held,
    }),
  ],
): CostReading {
  return {
    totalCostMicrocents: 12_000,
    rows,
    coverage: COMPLETE,
    models: undefined,
    governor:
      live === undefined
        ? undefined
        : { microcents: live.microcents, durabilityBroken: live.durabilityBroken === true },
  };
}

export const catalogEntry = (slug: string, valid = true): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `${slug}.relavium.yaml`,
  valid,
});

/** A cost port over a held amount that a release clears, every call recorded in the order it happened. */
export function fakeCost(
  initial: {
    held?: number;
    durabilityBroken?: boolean;
    /** What a release does instead of clearing the held amount (a half that reports otherwise, or one that throws). */
    release?: () => CostRelease;
  } = {},
) {
  let held = initial.held ?? 0;
  const calls: string[] = [];
  const read = vi.fn((): CostReading => {
    calls.push('read');
    return costReading(
      held,
      held > 0 || initial.durabilityBroken === true
        ? { microcents: held, durabilityBroken: initial.durabilityBroken === true }
        : undefined,
    );
  });
  const release = vi.fn((): CostRelease => {
    calls.push('release');
    if (initial.release !== undefined) return initial.release();
    const outcome = { durable: held, live: held };
    held = 0;
    return outcome;
  });
  const port: CostPort = { read, release };
  return { port, read, release, calls, heldNow: () => held };
}

export interface ReportRigOptions {
  /** Whether a turn is in flight when the release's answer asks. Mutable through {@link ReportRig.setTurn}. */
  readonly turn?: boolean;
  readonly settleMs?: number;
}

/** A popup host on a manual clock, with report popups opened on it and their frame "on screen" unless a test says otherwise. */
export function reportRig(options: ReportRigOptions = {}) {
  const clock = manualClock();
  const notifications = createNotificationChannel({ schedule: clock.schedule });
  const history = createChordHistory();
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    notifications,
    history,
    placement: 'overlay',
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  });
  let painted = true;
  host.bindVisibility(() => painted);
  // A host's gate is bound when it mounts, and a host with none opens nothing: this rig's host lets every open through.
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => 18);
  let turn = options.turn === true;
  const open = (
    port: Partial<ReportsPort>,
    line: ParsedReportLine,
    over: { readonly yieldToLoop?: () => Promise<void> } = {},
  ): PopupOpenResult =>
    openReportPopup({
      host,
      port: { surface: 'standalone-chat', ...port },
      line,
      origin: 'chat',
      turnInFlight: () => turn,
      yieldToLoop: over.yieldToLoop ?? (() => Promise.resolve()),
    });
  const content = (step?: number): PopupContent => {
    const frame = host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup is open');
    const state = frame.steps[step ?? frame.stepIndex];
    if (state === undefined) throw new Error('no such step');
    return state.content;
  };
  /** The words of the current step, whatever its kind. */
  const words = (): string => {
    const frame = host.getSnapshot().frame;
    if (frame === undefined) return '';
    const shown = currentStep(frame).state.content;
    switch (shown.kind) {
      case 'list':
        return shown.rows.map((row) => `${row.label} ${row.detail ?? ''}`).join('\n');
      case 'report':
        return shown.lines.join('\n');
      case 'loading':
        return shown.what;
      case 'empty':
      case 'error':
        return `${shown.what}\n${shown.next}`;
      case 'form':
        return [shown.summary ?? '', shown.warning ?? ''].join('\n');
      case 'done':
        return [shown.message, ...shown.lines].join('\n');
    }
  };
  return {
    host,
    clock,
    notifications,
    history,
    open,
    content,
    words,
    setTurn: (running: boolean): void => {
      turn = running;
    },
    show: (): void => host.shown(host.getSnapshot()),
    hide: (): void => {
      painted = false;
    },
    reveal: (): void => {
      painted = true;
    },
    press: (input: string, key: PopupKey = {}): boolean => host.input(input, key),
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    /** The letters the current step answers to now (its controls). */
    controls: (): readonly string[] => {
      const frame = host.getSnapshot().frame;
      return frame === undefined
        ? []
        : (currentStep(frame).spec.controls ?? []).map((control) => control.key);
    },
  };
}

export type ReportRig = ReturnType<typeof reportRig>;

/** A workflows port answering `reading` (or whatever `answer` returns), every read counted. */
export function fakeWorkflows(answer: () => WorkflowsReading | Promise<WorkflowsReading>) {
  const read = vi.fn(answer);
  return { port: { read }, read };
}
