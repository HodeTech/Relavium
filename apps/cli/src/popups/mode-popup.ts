/**
 * The `/mode` popup, in a chat and on the bare Home ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6, with its dated note of 2026-11-27; [MVP-11 unit 8 §6](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md), OD-25 / D84): ONE step on
 * the list screen, no rail, and no decision that changes nothing.
 *
 * - **The rows.** The four modes, each with its effect in a few words and, right-aligned and never cut, the state words `this chat` (the mode in
 *   force, a chat only) and `startup` (the saved startup default), both on one row when both are true. The highlighted mode's WHOLE effect is stated
 *   under the list (amber for `accept-edits` and `auto`, which approve without a card), so the effect is read before the key.
 * - **The keys follow the row.** In a chat `Enter` uses the highlighted mode in this chat now (`use in this chat`), or, on the mode in force, keeps
 *   (`keep`: nothing changes); `[s]` saves the highlighted mode as the startup default (`startup default`, written `startup` where the whole
 *   legend does not fit), and is absent from the row of the mode that already is the startup default. On the Home `Enter` sets the startup default
 *   (`set as startup default`), or, on the saved value, keeps. The `Enter` verb and `Esc close` never drop from the legend; `↑/↓ select` goes
 *   first when the row is short (`legendKeep`).
 * - **The only second screen** is the persistent write's confirmation, which is the startup-default writer's own flow framed as a popup
 *   (`mode-confirm.ts`): `Mode · Confirm · Done`. This module is the pure half of the list; the opener that answers is `settings-session.ts`.
 *
 * Pure builders. Every word drawn is the product's own: the modes are a closed set and their effects come from the one source
 * (`chat/mode-effects.ts`); the facts (which mode is in force, which is saved) pick rows and tags and are never drawn as text.
 */

import { CHAT_MODES, type ChatMode } from '@relavium/shared';

import { announcesEffect, MODE_EFFECT } from '../chat/mode-effects.js';
import type { StartupDefaultSaveResult } from '../chat/mode-settings.js';
import type { PopupContent, PopupListRow, PopupOrigin, PopupRowControl } from './frame-model.js';
import type { PopupSpec } from './popup-reducer.js';
import { fitNotice } from './popup-text.js';

/** The state word of the mode in force in this chat. */
export const MODE_THIS_CHAT = 'this chat';
/** The state word of the saved startup default (the global `default_mode`). */
export const MODE_STARTUP = 'startup';
/** The separator between two state words on one row (the legend's own). */
const STATE_SEPARATOR = ' · ';

/** The line above the modes in a chat: what the choice is about. */
export const MODE_INTRO = 'Choose how the agent treats an effect.';
/** The line above the modes on the Home: there is no conversation, so the choice is the startup default. */
export const MODE_INTRO_HOME = 'Choose the startup default for new chats.';

/** The id of the intro's row (a heading: it is never highlighted and never answers). */
const INTRO_ROW = 'intro';

/** What `Enter` says on a mode that is not the one in force in this chat: it applies at once, and the popup closes. */
export const MODE_USE_VERB = 'use in this chat';
/** What `Enter` says on the mode that is already in force (or already the startup default on the Home): nothing changes. */
export const MODE_KEEP_VERB = 'keep';
/** What `Enter` says on the Home on a mode that is not the saved startup default: it opens the confirmation of the persistent write. */
export const MODE_SET_STARTUP_VERB = 'set as startup default';
/** The letter that opens the persistent write's confirmation in a chat, and its two verbs: the whole one and the one written where the row is short. */
export const MODE_STARTUP_KEY = 's';
const STARTUP_VERB = 'startup default';
const STARTUP_VERB_SHORT = 'startup';

/** The width of the name column: the longest mode name (the list's two-space gap after it makes the plus two), so every row's effect starts in one column. */
const NAME_COLUMN = Math.max(...CHAT_MODES.map((mode) => mode.length));

/** What the list is built from: where it is drawn, the mode in force (a chat only) and the saved startup default (`undefined`: not known). */
export interface ModeListFacts {
  readonly surface: 'chat' | 'home';
  /** The mode in force in this chat; absent on the Home. */
  readonly current?: ChatMode | undefined;
  /** The saved startup default: the mode `startup` marks. `undefined` where it could not be read: no row is marked and `[s]` is offered on every row. */
  readonly startup?: ChatMode | undefined;
}

/** The mode a row stands for, or `undefined` for a row that is none (the intro). */
export function modeOfRow(id: string | undefined): ChatMode | undefined {
  return CHAT_MODES.find((mode) => mode === id);
}

/** The state words of `mode`'s row: `this chat`, `startup`, both with their separator, or none. */
export function modeStateWords(facts: ModeListFacts, mode: ChatMode): string | undefined {
  const words = [
    facts.surface === 'chat' && mode === facts.current ? MODE_THIS_CHAT : undefined,
    mode === facts.startup ? MODE_STARTUP : undefined,
  ].filter((word): word is string => word !== undefined);
  return words.length === 0 ? undefined : words.join(STATE_SEPARATOR);
}

/** What `Enter` says on `mode`'s row (see the module header). */
export function modeEnterVerb(facts: ModeListFacts, mode: ChatMode): string {
  if (facts.surface === 'home')
    return mode === facts.startup ? MODE_KEEP_VERB : MODE_SET_STARTUP_VERB;
  return mode === facts.current ? MODE_KEEP_VERB : MODE_USE_VERB;
}

/** The letters `mode`'s row answers to: `[s]` in a chat, unless the mode already is the startup default; none on the Home (its `Enter` is the write). */
function modeControls(facts: ModeListFacts, mode: ChatMode): readonly PopupRowControl[] {
  if (facts.surface === 'home' || mode === facts.startup) return [];
  return [{ key: MODE_STARTUP_KEY, verb: STARTUP_VERB, short: STARTUP_VERB_SHORT }];
}

/** `mode`'s name, padded to the name column. */
function nameOf(mode: ChatMode): string {
  return mode.padEnd(NAME_COLUMN);
}

/**
 * The list: the intro, then each mode (its name in the name column, its effect in a few words, its state words at the row's end) with its
 * whole effect, which the frame states under the list while the row is highlighted, and the `Enter` and the letters of its row.
 */
export function modeContent(facts: ModeListFacts): PopupContent {
  const rows: PopupListRow[] = [
    {
      id: INTRO_ROW,
      label: facts.surface === 'chat' ? MODE_INTRO : MODE_INTRO_HOME,
      section: true,
      enabled: false,
    },
    ...CHAT_MODES.map((mode): PopupListRow => {
      const tag = modeStateWords(facts, mode);
      return {
        id: mode,
        label: nameOf(mode),
        detail: MODE_EFFECT[mode].short,
        effect: MODE_EFFECT[mode].full,
        ...(announcesEffect(mode) ? { effectTone: 'warn' as const } : {}),
        ...(tag === undefined ? {} : { tag }),
        enterVerb: modeEnterVerb(facts, mode),
        controls: modeControls(facts, mode),
      };
    }),
  ];
  return { kind: 'list', rows };
}

/**
 * The popup's spec: ONE step (so no rail and no `step N of M`), opened on the mode `current` in a chat and on the saved default on the Home, so a
 * bare `Enter` keeps and changes nothing, or on `initial` (the mode a step back from the confirmation returns to). `Esc` closes. The step's own `Enter` word is the row's (`PopupListRow.enterVerb`); `legendKeep` makes
 * `↑/↓ select` the first item to go when the row is short.
 */
export function modeSpec(origin: PopupOrigin, facts: ModeListFacts, initial?: ChatMode): PopupSpec {
  const opened = initial ?? (facts.surface === 'chat' ? facts.current : facts.startup);
  return {
    id: 'mode',
    title: '/mode',
    origin,
    steps: [
      {
        name: 'Mode',
        content: modeContent(facts),
        enter: MODE_KEEP_VERB,
        ...(opened === undefined ? {} : { initialRow: opened }),
        legendKeep: ['Enter', MODE_STARTUP_KEY],
      },
    ],
  };
}

/**
 * What the Home says when the startup default could not be read, so the list (which IS the startup default there) does not open: the writer's own
 * sentence for a refusal before anything was saved (`chat/mode-settings.ts`), the one the Home has always said.
 */
export const MODE_NOT_COMPLETED =
  'Mode settings could not be completed. Startup default unchanged.';

/** What the Home says on its channel when `Enter` was pressed on the mode that is already the startup default: one notification, no screen. */
export function startupAlreadyAnnouncement(mode: ChatMode): string {
  return fitNotice(`Startup default is already ${mode}`);
}

/**
 * What the startup default says on the host's channel once the startup-default writer's flow has ended without a step of its own that said
 * it (ADR-0148 §6: a setting writes nothing into the transcript): one fact in a few words, the one that matters most first. Every form is at
 * most 54 columns (`fitNotice`); the mode and the overriding layer are the product's own closed words. The confirmation's Done step
 * (`mode-confirm.ts`) leads with it, the flow's whole sentence under it when that says more.
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
