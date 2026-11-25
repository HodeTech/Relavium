/**
 * What a host hands the settings popups, and the one way a host opens one ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6; [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): `/mode`, `/effort`, `/models` and
 * `/permissions`, opened from an interactive chat (the chat the Home hosts and a stand-alone `relavium chat`). This module is the EAGER half,
 * split from the lazy half as `report-port.ts` is: types, the one table of the settings, the parse of a typed line, the words a setting that
 * applied announces, and a loader that brings the popups' code in (`settings-session.ts` and what it imports) only when the person first asks
 * for a setting, so a host never pays for it at start.
 *
 * **A setting writes nothing into the transcript or a Home notice** (the residue rule, ADR-0148 §6): it closes as it applies, and it is
 * confirmed by the status line, which shows the value, and by one transient notification on the HOST's channel ({@link SettingsPort.announce}),
 * which outlives the popup (what a popup says through its own context is discarded when it closes).
 *
 * **Only the bare command opens a popup.** A typed argument applies directly, through the command's own dispatch, with the same result and the
 * same notification (`/mode plan`, `/effort high`: ADR-0148 §6), and an argument a command does not take is rejected there. So the parse never
 * widens what it accepts: any line with a word after the command is not a settings line.
 *
 * The hosts route and open, and hold no popup logic: the chat host (`chat-ink.tsx`) and the Home controller recognise the line through the one
 * routing (`popup-route.ts`) in the same place they open the reports, BEFORE the line is counted as a submit, and call {@link openSettings}. A
 * plain, `--json` or one-shot chat has no port and prints exactly the text it printed before.
 *
 * A data module: it imports nothing from `ink`, `react` or `node:` (ADR-0145 §10), and its loader is a relative dynamic import.
 */

import type { ReasoningEffort } from '@relavium/shared';

import type { Surface } from '../render/surface.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupHost } from './popup-host.js';
import type { PopupWorkOwner } from './popup-work.js';

/** Where a setting is changed: a chat the Home hosts, a stand-alone `relavium chat`, or (for `/models`, a later increment) the bare Home. */
export type SettingsSurface = Extract<Surface, 'home' | 'home-chat' | 'standalone-chat'>;

/**
 * What the `/effort` popup reads and does: the tiers THIS model takes, the tier the session uses now, and the session's own setter. Each is read
 * when the popup opens or answers, never while it is drawn.
 */
export interface EffortSettingsPort {
  /** The model the session is bound to (a tier's label is the model's: a budget model's `medium` reads `on`). */
  readonly model: () => string;
  /** The tiers this model takes, in canonical order (`effortTiersFor`); none ⇒ `/effort` is no popup here and prints why, as before. */
  readonly tiers: () => readonly ReasoningEffort[];
  /** The tier the session uses now (the footer's), or `undefined` for the provider's default. */
  readonly current: () => ReasoningEffort | undefined;
  /** Apply a tier to THIS session: the session's override and the footer, no reseat and no config write (`modeControl.onSetEffort`). */
  readonly apply: (effort: ReasoningEffort) => void;
}

/**
 * A member whose popup is not built yet (MVP-11 step 5: `/mode`, `/models` and the chat's `/permissions` are later increments of this step). It
 * can only be absent, so the routing never names its command and the line goes on to what opens it today (the native `/mode` flow, the `/models`
 * picker, the docked `/permissions` sheet). The increment that builds the popup replaces this type with its own port.
 */
export type PendingSettingsPort = never;

/** What a chat host hands the settings popups. Built once per chat session; nothing in it is read until a popup runs. */
export interface SettingsPort {
  readonly surface: SettingsSurface;
  /** The owner a popup's work starts on (a catalog refresh), and a fault of it goes to (`startPopupWork`). */
  readonly workOwner?: PopupWorkOwner | undefined;
  /**
   * One transient notification on the HOST's channel (`NotificationChannel.notify` with no popup as its source): what a setting that applied
   * says, drawn once its popup has closed. Never the transcript, never a Home notice. The chat's line handler supplies it (the same function its
   * typed settings and its mode control announce through), and the host binds it to its channel (`ChatLineHandler.setAnnouncer`).
   */
  readonly announce: (text: string) => void;
  readonly mode?: PendingSettingsPort;
  readonly effort?: EffortSettingsPort | undefined;
  readonly models?: PendingSettingsPort;
  readonly permissions?: PendingSettingsPort;
}

/** One setting: the port member it needs, the command that names it, and what its typed argument does. */
interface SettingsDefinition {
  readonly kind: Exclude<keyof SettingsPort, 'surface' | 'workOwner' | 'announce'>;
  readonly command: string;
  /**
   * What a word after the command does. `applies`: it is the value, applied directly through the command's dispatch with no popup (`/mode plan`,
   * `/effort high`). `rejected`: the command takes none, and the dispatch says so (`/models x`, `/permissions x`). Either way only the bare
   * command is a settings line.
   */
  readonly argument: 'applies' | 'rejected';
}

/**
 * The settings, in one table: what a typed line is matched against ({@link parseSettingsLine}) and which member of the port the popup needs. **The
 * kinds are read from this table** ({@link SettingsKind}, {@link SettingsMembers}), so a fifth setting is one row here, which names a member of
 * the port (a row for a member that is not there does not compile), and which the opener table of `settings-session.ts` (typed over
 * {@link SettingsKind}) then requires.
 */
export const SETTINGS = [
  { kind: 'mode', command: '/mode', argument: 'applies' },
  { kind: 'effort', command: '/effort', argument: 'applies' },
  { kind: 'models', command: '/models', argument: 'rejected' },
  { kind: 'permissions', command: '/permissions', argument: 'rejected' },
] as const satisfies readonly SettingsDefinition[];

/** The setting a typed line names: the name of the member of the port that makes it a popup. */
export type SettingsKind = (typeof SETTINGS)[number]['kind'];

/**
 * The members of a {@link SettingsPort} that come from the session's own line handler: the settings and the announcement it routes to the
 * host's channel (the host adds the surface and the owner).
 */
export type SettingsMembers = Pick<SettingsPort, SettingsKind | 'announce'>;

export interface ParsedSettingsLine {
  readonly kind: SettingsKind;
}

/**
 * A typed settings line a popup answers: the bare command, white space around it ignored (`/mode`, `/effort`, `/models`, `/permissions`). **Any
 * line with a word after the command is `undefined`** and goes on to the command's own dispatch (see {@link SettingsDefinition.argument}).
 */
export function parseSettingsLine(line: string): ParsedSettingsLine | undefined {
  const [name, ...tokens] = line.trim().split(/\s+/u);
  const setting = SETTINGS.find((candidate) => candidate.command === name);
  return setting === undefined || tokens.length > 0 ? undefined : { kind: setting.kind };
}

/**
 * Whether `port` can open the setting `kind` now: its member is wired, and for `/effort` the model has a tier to offer (a model with none keeps
 * the command's sentence, which says why). A host that did not wire a member dispatches the line, as before.
 */
export function settingsAvailable(port: SettingsPort, kind: SettingsKind): boolean {
  switch (kind) {
    case 'effort':
      return port.effort !== undefined && port.effort.tiers().length > 0;
    case 'mode':
    case 'models':
    case 'permissions':
      return port[kind] !== undefined;
  }
}

/**
 * What a reasoning tier that was chosen announces (the popup's `Enter` and a typed `/effort <tier>` alike), in the words of the tier's label
 * (`on` for a budget model): `Reasoning effort: high · applies to the next message`, or `Already at reasoning effort high.` when it was the
 * tier in force. At most 54 columns with the longest label (`medium`), so it is read whole beside a popup's way back
 * (`POPUP_NOTICE_MAX_COLUMNS`).
 */
export function effortAnnouncement(label: string, already: boolean): string {
  return already
    ? `Already at reasoning effort ${label}.`
    : `Reasoning effort: ${label} · applies to the next message`;
}

/** What a host asks for when it opens a setting. */
export interface SettingsOpenRequest {
  readonly host: PopupHost;
  readonly port: SettingsPort;
  readonly command: SettingsKind;
  readonly origin: PopupOrigin;
}

/**
 * Open the settings popup `request.command` names over `request.host`, loading its code on first use. The promise settles once the popup is
 * open or refused (the host's gate says why in one notification); it rejects only when the code could not be loaded, which the caller reports as
 * a fault of its own, as `openReport`'s caller does.
 */
export async function openSettings(request: SettingsOpenRequest): Promise<void> {
  const { openSettingsPopup } = await import('./settings-session.js');
  openSettingsPopup(request);
}
