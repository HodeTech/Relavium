/**
 * `/mode` on the bare Home, drawn as a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6; [MVP-11 Appendix A](../../../../docs/roadmap/phases/mvp-11.md#appendix-a--command-classification): `/mode` is a two-step popup). The
 * bare Home has no conversation, so its `/mode` is a PERSISTENT write of the global startup default, and it is the startup-default writer's own
 * flow (`runModeSettings`, `chat/mode-settings.ts`), unchanged: this module changes the SURFACE it is drawn on, never its authority. Every guard,
 * record and admission of that flow stays as it is (the confirmed narrowing's revocation, the config-rewrite disclosure on the visible frame,
 * the visibly admitted publication, `auto`'s risk sentence and its extra admission after the write).
 *
 * - **The rail is `Mode · Confirm · Done`.** `Mode` is the flow's own choice of the four modes, each with its whole effect (`MODE_DESCRIPTION`,
 *   so the highlighted mode's whole effect is on screen), opened on the global default, under the flow's own note of the effective start.
 * - **`Confirm` is a chord** (§3: "keeps today's confirmation that defaults to *No* and is answered with `Ctrl+Y`"): the flow's confirmation is
 *   asked as the channel's chord card, which states what is written (the startup default), to which file (from `~` or project-relative) and
 *   what stays. Only an `allow` the chord guard let through confirms; `Ctrl+N`, `Ctrl+C`, a closed Home and every other key confirm nothing, and
 *   the card's guard layers (the lockout from its measured frame, the held-key and typeahead layers) are the channel's, unchanged. `Esc` steps
 *   back to `Mode` (the flow is run again from its start, opened on the mode chosen: nothing was done before the confirmation).
 * - **`Done` is persistent** (§6): a write that happened, or one that failed, is said on the popup's last step with the file it went to,
 *   closed by `Enter` or `Esc`. Nothing goes into the Home's notice; a confirmation declined is ONE notification (what this resolves with), and
 *   the status line, which the controller reads again however the flow ended, shows the new value.
 */

import { CHAT_MODES, type ChatMode } from '@relavium/shared';

import {
  runModeSettings,
  startupDefaultResultOf,
  type ModeSettingsOptions,
  type StartupDefaultSaveResult,
} from '../chat/mode-settings.js';
import { framedFlow, type FramedChordFlow } from '../home/framed-flow.js';
import {
  NATIVE_PROMPT_BACK,
  type NativeChordPort,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { startupDefaultAnnouncement } from './mode-popup.js';

/** The popup's name on its top edge: the command, as on every other popup. */
export const MODE_HOME_TITLE = '/mode';
/** The rail's steps. */
export const MODE_HOME_STEPS = ['Mode', 'Confirm', 'Done'] as const;
const MODE_STEP = 0;
const CONFIRM_STEP = 1;

/** The chord card's two answers (the legend names them: `Ctrl+Y save it`, `Ctrl+N save nothing`). */
export const MODE_SAVE_LABEL = 'Save it';
export const MODE_KEEP_LABEL = 'Save nothing';

/** What the confirmation says it writes, for `mode` (a product sentence; the mode is a closed word). */
export function modeWriteLine(mode: ChatMode): string {
  return `Writes the startup default of new chats: default_mode = ${mode}`;
}
/** Where it writes, `target` being the file as a person reads it (the caller's scrubbed words). */
export function modeFileLine(target: string): string {
  return `File: ${target}`;
}
/** What the confirmation says stays as it is. */
export const MODE_STAYS_LINE =
  'Stays: the file’s other settings, and a project or workspace mode where one is set';

/** What a confirmation declined (or cancelled at the card) says: the one notification of a popup that wrote nothing. */
export const MODE_UNCHANGED = startupDefaultAnnouncement('ask', { kind: 'unchanged' });

export interface HomeModeSettingsDeps extends Omit<
  ModeSettingsOptions,
  'flow' | 'notice' | 'currentMode' | 'onCurrentMode'
> {
  /** The Home's native prompt flow (with its chord card): framed here as the `/mode` popup. */
  readonly flow: NativePromptFlow & NativeChordPort;
  /**
   * The file the startup default is written to, as a person reads it (`~/.relavium/config.toml`, or project-relative), already through the
   * full scrub: drawn on the confirmation and on the Done step.
   */
  readonly target: string;
}

/** What one run of the flow came to, as the adapter saw it. */
interface Observed {
  /** The mode the person last chose on `Mode` (what the confirmation names and a step back opens on). */
  chosen: ChatMode | undefined;
  /** The confirmation was asked (a later end without a write is a decline, said in one notification). */
  asked: boolean;
  /** The confirmation was stepped back from with `Esc`: the flow is run again, from `Mode`. */
  steppedBack: boolean;
  /** The flow's one sentence (`runModeSettings`' `notice`), never drawn on the Home's notice. */
  said: string | undefined;
}

/** The mode a select answered with, or `undefined` for none (a step back, a cancel). */
function modeOf(answer: string | symbol): ChatMode | undefined {
  return CHAT_MODES.find((mode) => mode === answer);
}

/** The confirmation's body: what is written, where, and what stays. */
function confirmDetails(mode: ChatMode | undefined, target: string): readonly string[] {
  return [
    ...(mode === undefined ? [] : [modeWriteLine(mode)]),
    modeFileLine(target),
    MODE_STAYS_LINE,
  ];
}

/**
 * The flow `runModeSettings` is given: the framed flow, its one select on `Mode` (opened on the mode chosen before a step back), its one
 * confirmation asked as the chord card on `Confirm`. Nothing else of the flow changes.
 */
function adaptedFlow(
  framed: FramedChordFlow,
  signal: AbortSignal,
  target: string,
  seen: Observed,
): NativePromptFlow {
  return {
    ...framed,
    select: async (request) => {
      const answer = await framed.at(MODE_STEP).select({
        ...request,
        ...(seen.chosen === undefined ? {} : { initialValue: seen.chosen }),
      });
      seen.chosen = modeOf(answer) ?? seen.chosen;
      return answer;
    },
    confirm: async (message) => {
      seen.asked = true;
      const answer = await framed.at(CONFIRM_STEP).chord({
        message,
        details: confirmDetails(seen.chosen, target),
        allow: MODE_SAVE_LABEL,
        deny: MODE_KEEP_LABEL,
        escape: 'back',
        signal,
      });
      if (answer === NATIVE_PROMPT_BACK) seen.steppedBack = true;
      // Only an `allow` the chord guard let through confirms: never "anything that is not a `deny`".
      return typeof answer === 'symbol' ? answer : answer === 'allow';
    },
  };
}

/** Whether a result says more than its Done sentence does (an override, a restart, an unconfirmed durability, a refusal): its sentence is then drawn under it. */
function saysMore(result: StartupDefaultSaveResult): boolean {
  if (result.kind !== 'saved') return true;
  return (
    result.overriddenBy !== undefined ||
    result.autoAfterRestart ||
    result.unfinished ||
    result.durability !== 'confirmed'
  );
}

/**
 * What the popup ends with once the flow has: the Done step for a write that happened or failed (resolves `undefined`: the popup said it),
 * the one notification of a confirmation declined, or nothing for a popup closed before its confirmation.
 */
async function finish(
  framed: FramedChordFlow,
  seen: Observed,
  target: string,
): Promise<string | undefined> {
  const result = startupDefaultResultOf(seen.said);
  const mode = seen.chosen;
  if (result.kind === 'unchanged' || mode === undefined)
    return seen.asked ? MODE_UNCHANGED : undefined;
  await framed.done({
    message: startupDefaultAnnouncement(mode, result),
    target,
    ...(saysMore(result) && seen.said !== undefined ? { lines: [seen.said] } : {}),
    tone: result.kind === 'saved' ? 'ok' : 'failed',
  });
  return undefined;
}

/**
 * Run the bare Home's `/mode` as a popup (see the module header). Resolves with the ONE notification the Home shows (a declined
 * confirmation), or `undefined` when the popup said what happened (its Done step) or was closed before it asked anything. The frame is begun
 * here and ended here, around every run of the flow, so a step back keeps one box.
 */
export async function runHomeModeSettings(deps: HomeModeSettingsDeps): Promise<string | undefined> {
  const { flow, target, ...options } = deps;
  const framed = framedFlow(flow, {
    title: MODE_HOME_TITLE,
    origin: 'home',
    stepNames: MODE_HOME_STEPS,
    progress: 'manual',
  });
  const signal = framed.begin();
  const seen: Observed = { chosen: undefined, asked: false, steppedBack: false, said: undefined };
  try {
    do {
      seen.steppedBack = false;
      seen.asked = false;
      await runModeSettings({
        ...options,
        flow: adaptedFlow(framed, signal, target, seen),
        notice: (text) => {
          seen.said = text;
        },
      });
    } while (seen.steppedBack && seen.said === undefined && !signal.aborted);
    return await finish(framed, seen, target);
  } finally {
    await framed.end();
  }
}
