/**
 * Test support for the settings popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6): a popup host on a manual monotonic clock with a settings popup opened on it, a settings port over fakes whose every call is recorded
 * (the session's setter, the announcement on the host's channel), and the words of the step on screen. Nothing here reaches a session, a
 * database, a disk or a network.
 */

import type { ChatMode, ReasoningEffort } from '@relavium/shared';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import { manualClock } from './doctor.test-support.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost, type PopupOpenResult } from './popup-host.js';
import { currentStep, visibleRows, type PopupKey } from './popup-reducer.js';
import type {
  ModeSettingsPort,
  SettingsKind,
  SettingsPort,
  SettingsSurface,
  StartupDefaultOutcome,
} from './settings-port.js';
import { openSettingsPopup } from './settings-session.js';

/** An `/effort` member over `model` and `tiers`, the tier in force `current`, every apply recorded (and moving the tier in force). */
export function fakeEffort(
  model: string,
  tiers: readonly ReasoningEffort[],
  current: ReasoningEffort | undefined,
) {
  let now = current;
  const applied: ReasoningEffort[] = [];
  return {
    applied,
    current: (): ReasoningEffort | undefined => now,
    member: {
      model: () => model,
      tiers: () => tiers,
      current: () => now,
      apply: (effort: ReasoningEffort) => {
        applied.push(effort);
        now = effort;
      },
    } satisfies NonNullable<SettingsPort['effort']>,
  };
}

/**
 * A `/mode` member over fakes (MVP-11 unit 8, OD-25): a chat's (`scope: 'chat'`, the mode in force `current`) or the bare Home's, the saved
 * startup default `startup` (`undefined`: it could not be read), every apply and hand-off recorded. `outcome` is what the hand-off comes to
 * (`said` unless a case says otherwise; a function is asked each time, so a step back can be followed by another answer); `accepts` is what the
 * session's setter answers.
 */
export function fakeModeMember(options: {
  readonly scope?: 'chat' | 'home';
  readonly current?: ChatMode;
  readonly startup?: ChatMode | undefined;
  readonly accepts?: boolean;
  readonly outcome?: StartupDefaultOutcome | (() => StartupDefaultOutcome | Promise<never>);
}) {
  const scope = options.scope ?? 'chat';
  let now: ChatMode = options.current ?? 'ask';
  const applied: ChatMode[] = [];
  const saved: ChatMode[] = [];
  const startup = (): ChatMode | undefined => options.startup;
  const saveStartupDefault = (mode: ChatMode): Promise<StartupDefaultOutcome> => {
    saved.push(mode);
    const outcome = options.outcome ?? ({ kind: 'said' } as const);
    return typeof outcome === 'function'
      ? Promise.resolve().then(outcome)
      : Promise.resolve(outcome);
  };
  const member: ModeSettingsPort =
    scope === 'home'
      ? { scope, startup, saveStartupDefault }
      : {
          scope,
          startup,
          saveStartupDefault,
          current: () => now,
          apply: (mode) => {
            applied.push(mode);
            if (options.accepts ?? true) now = mode;
            return options.accepts ?? true;
          },
        };
  return { member, applied, saved, mode: (): ChatMode => now };
}

export const ENTER: PopupKey = { return: true };
export const ESC: PopupKey = { escape: true };
export const DOWN: PopupKey = { downArrow: true };
export const UP: PopupKey = { upArrow: true };

/** A popup host on a manual clock with its frame "on screen", and a settings popup opened on it through the opener table. */
export function settingsRig() {
  const clock = manualClock();
  const notifications = createNotificationChannel({ schedule: clock.schedule });
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    notifications,
    history: createChordHistory(),
    placement: 'overlay',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => 17);
  host.bindInnerWidth(() => 66);
  /** Every announcement the port made, in order (the host's channel shows them one at a time). */
  const announced: string[] = [];
  const open = (
    members: Partial<SettingsPort>,
    command: SettingsKind,
    surface: SettingsSurface = 'standalone-chat',
  ): PopupOpenResult =>
    openSettingsPopup({
      host,
      port: {
        surface,
        announce: (text) => {
          announced.push(text);
          notifications.notify(text);
        },
        ...members,
      },
      command,
      origin: surface === 'home' ? 'home' : 'chat',
    });
  return {
    host,
    clock,
    notifications,
    announced,
    open,
    /** The popup has appeared and its settle time has passed: an `Enter` may answer. */
    settle: (): void => {
      host.shown(host.getSnapshot());
      // Past the opening guard's settle AND the form's lockout after the answer that reached it (`popup-host.ts`: a form's `Enter` waits out
      // `APPROVAL_LOCKOUT_MS` so a held key's first repeat cannot apply it), so the `Enter` pressed next is a deliberate one.
      clock.advance(APPROVAL_LOCKOUT_MS + 100);
    },
    press: (input: string, key: PopupKey = {}): boolean => host.input(input, key),
    /** The rows of the step on screen, as `label detail`, and the one highlighted. */
    rows: (): { readonly all: readonly string[]; readonly highlighted: string | undefined } => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return { all: [], highlighted: undefined };
      const { state } = currentStep(frame);
      const shown = visibleRows(state);
      return {
        all: shown.map((row) => `${row.label} ${row.detail ?? ''}`.trim()),
        highlighted: shown[state.selected]?.id,
      };
    },
  };
}
