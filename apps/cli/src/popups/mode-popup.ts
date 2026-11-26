/**
 * The `/mode` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3,
 * §6; [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups), `popup-mode-chat-80x24.png`; the two steps of
 * the 2026-11-25 ruling). Step 1, **Mode**: the four modes, each with its effect in a few words, the mode in force marked `current` and opened
 * on, so a bare `Enter` chain changes nothing; the highlighted mode's whole effect is stated under the list (the room of the longest kept, so
 * the frame never jumps). `Enter` goes on to step 2, **Apply to**: a form that names the mode, states its effect again where it approves
 * something without a card (`accept-edits`, `auto`), and asks where it applies: this chat (the default) or new chats. `Enter` applies; `Esc`
 * steps back, and closes from step 1.
 *
 * Pure builders: the rows, the form and the spec. The opener that answers is `settings-session.ts`; neither is loaded until the person first
 * opens a setting (`settings-port.ts`).
 *
 * Every word drawn is the product's own: the modes are a closed set and their effects come from the one source (`chat/mode-effects.ts`); the
 * port gives only which mode is in force, which picks a row and is never drawn as text.
 */

import { CHAT_MODES, type ChatMode } from '@relavium/shared';

import { announcesEffect, MODE_EFFECT } from '../chat/mode-effects.js';
import type { StartupDefaultSaveResult } from '../chat/mode-settings.js';
import type { PopupContent, PopupForm, PopupListRow, PopupOrigin } from './frame-model.js';
import type { PopupSpec } from './popup-reducer.js';
import { fitNotice } from './popup-text.js';

/** The word beside the mode in force. */
export const MODE_CURRENT = 'current';

/** The line above the modes: what the choice is about. */
export const MODE_INTRO = 'Choose how the agent treats an effect.';

/** The id of the intro's row (a heading: it is never highlighted and never answers). */
const INTRO_ROW = 'intro';

/** The step that asks where the chosen mode applies (the first step lists the modes). */
export const SCOPE_STEP = 1;

/** Where a chosen mode applies: this chat (the session's mode, now), or new chats (the global startup default). */
export type ModeScope = 'this-chat' | 'new-chats';

/** The radio group of step 2, in the order drawn; the first is the default. */
const SCOPES: readonly {
  readonly id: ModeScope;
  readonly label: string;
  readonly detail: string;
}[] = [
  { id: 'this-chat', label: 'This chat', detail: 'switches the mode now; the conversation stays' },
  {
    id: 'new-chats',
    label: 'New chats',
    detail: 'saves it as your startup default; this chat stays',
  },
];

/** The mode a row of step 1 stands for, or `undefined` for a row that is none (the intro). */
export function modeOfRow(id: string | undefined): ChatMode | undefined {
  return CHAT_MODES.find((mode) => mode === id);
}

/** The scope a radio option of step 2 stands for, or `undefined` for none. */
export function scopeOf(id: string | undefined): ModeScope | undefined {
  return SCOPES.find((scope) => scope.id === id)?.id;
}

/**
 * Step 1's list: the intro, then each mode (its name, its effect in a few words, `· current` after the one in force) with its whole effect,
 * which the frame states under the list while the row is highlighted.
 */
export function modeContent(current: ChatMode): PopupContent {
  const rows: PopupListRow[] = [
    { id: INTRO_ROW, label: MODE_INTRO, section: true, enabled: false },
    ...CHAT_MODES.map(
      (mode): PopupListRow => ({
        id: mode,
        label: mode,
        detail:
          mode === current
            ? `${MODE_EFFECT[mode].short} · ${MODE_CURRENT}`
            : MODE_EFFECT[mode].short,
        effect: MODE_EFFECT[mode].full,
      }),
    ),
  ];
  return { kind: 'list', rows };
}

/**
 * Step 2's form for `mode`: the mode it sets, where it applies (this chat by default), and, for a mode that approves something without a
 * card, its whole effect as the warning `Enter` applies under (ADR-0148 §3: a setting states its effect before it applies).
 */
export function modeScopeForm(mode: ChatMode): PopupForm {
  return {
    kind: 'form',
    summary: `Mode: ${mode}`,
    radio: {
      label: 'Apply to',
      verb: 'apply to',
      initial: 'this-chat',
      options: SCOPES,
    },
    ...(announcesEffect(mode) ? { warning: MODE_EFFECT[mode].full, guarded: true as const } : {}),
  };
}

/**
 * The popup's spec, opened on the mode in force (`current`): step 1 lists the modes (`Enter next`), step 2 asks where the chosen one applies
 * (`Enter apply`; its content is set for the chosen mode when step 1 answers). `Esc` steps back from step 2 and closes from step 1.
 */
export function modeSpec(origin: PopupOrigin, current: ChatMode): PopupSpec {
  return {
    id: 'mode',
    title: '/mode',
    origin,
    steps: [
      { name: 'Mode', content: modeContent(current), enter: 'next', initialRow: current },
      {
        name: 'Apply to',
        content: modeScopeForm(current),
        enter: 'apply',
        legendKeep: ['Enter'],
      },
    ],
  };
}

/**
 * What "New chats" says on the host's channel once the startup-default writer's flow has ended (ADR-0148 §6: a setting writes nothing into the
 * transcript; the flow's card, its confirmation and its rewrite disclosure, is not residue and stays): one fact in a few words, the one that
 * matters most first. Every form is at most 54 columns (`fitNotice`); the mode and the overriding layer are the product's own closed words. The
 * bare Home's `/mode` popup (`mode-home.ts`) leads its Done step with it, the flow's whole sentence under it when that says more.
 */
export function startupDefaultAnnouncement(
  mode: ChatMode,
  result: StartupDefaultSaveResult,
): string {
  if (result.kind === 'unchanged') return fitNotice('Startup default unchanged');
  if (result.kind === 'refused')
    return fitNotice(
      result.autoRevoked
        ? 'Startup default not saved; startup auto stays revoked'
        : 'The startup default could not be saved',
    );
  if (result.overriddenBy !== undefined)
    return fitNotice(`Startup default saved; this ${result.overriddenBy} overrides it`);
  if (result.autoAfterRestart)
    return fitNotice('Startup default saved; auto applies after a restart');
  if (result.unfinished) return fitNotice('Startup default saved; mode settings could not finish');
  if (result.durability === 'unconfirmed')
    return fitNotice('Startup default saved; durability unconfirmed');
  return fitNotice(
    `Startup default: ${mode} · applies to new chats`,
    `Startup default saved: ${mode}`,
  );
}
