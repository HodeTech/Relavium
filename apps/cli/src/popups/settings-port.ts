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

import type { ChatMode, ReasoningEffort } from '@relavium/shared';

import type { ModelCatalogEntry, ProviderId } from '@relavium/llm';

import type { RefreshReport } from '../engine/model-refresh.js';
import type { PermissionsPort } from '../permissions/chat-permissions.js';
import type { Surface } from '../render/surface.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupHost } from './popup-host.js';
import type { PopupWorkOwner } from './popup-work.js';

/** Where a setting is changed: a chat the Home hosts, a stand-alone `relavium chat`, or (for `/models`) the bare Home. */
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
 * What the `/mode` popup of a chat reads and does (ADR-0148 §3, §6; the two steps of the 2026-11-25 ruling: the mode, then where it applies):
 * the mode the session is in now, the session's one mode setter for THIS chat, and the hand-off to the startup-default writer for NEW chats.
 * Each is read when the popup opens or answers, never while it is drawn. Only a chat has it: the bare Home's `/mode` sets the startup default
 * through its own flow ({@link settingsAvailable}).
 */
export interface ModeSettingsPort {
  /** The mode the session is in now (the status line's). */
  readonly current: () => ChatMode;
  /**
   * Apply `mode` to THIS chat through the session's one mode setter (`ChatModeControl.onModeChange`): it records the change, refuses a
   * widening whose record could not be written, and says what it did on the host's channel itself (a change into `accept-edits` or `auto`,
   * a refusal), so the popup adds no word. Returns whether `mode` is in force now.
   */
  readonly apply: (mode: ChatMode) => boolean;
  /**
   * Save `mode` as the global startup default for new chats, on this chat's native prompt: the existing writer's flow
   * (`runStartupDefaultSave`, `chat/mode-settings.ts`) with its confirmation that defaults to No (`auto` states its effect first), the
   * config-rewrite disclosure and its publication, and its result in its own words. Started once the popup has closed; this chat's mode does
   * not change.
   */
  readonly saveStartupDefault: (mode: ChatMode) => Promise<void>;
}

/**
 * What a model chosen in `/models` is ([ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)): the catalog row's id and
 * provider (the provider is the row's, never inferred from the id) and, for a model that takes a reasoning tier, the tier chosen with it. The
 * shape of a reseat's target, so a chat's switch hands it on as it is.
 */
export interface ModelChoice {
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * What saving the default model of new chats came to, as its writer's adapter says it (it never rejects): `saved`, with the writer's
 * durability and whether a chat started here now would start on it (`applies`; `overridden`: a project or workspace setting names another
 * model; `unknown`: the configuration could not be read again), or `refused` (the config is a symbolic link, the write failed, the person
 * cancelled the writer's card, or the host is closing and nothing is said).
 */
export type DefaultModelSaveResult =
  | {
      readonly kind: 'saved';
      readonly durability: 'confirmed' | 'unconfirmed';
      readonly effect: 'applies' | 'overridden' | 'unknown';
    }
  | { readonly kind: 'refused'; readonly reason: 'symlink' | 'failed' | 'cancelled' | 'closing' };

/**
 * What the `/models` popup reads and does ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6; [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §10): the merged catalog and its two refreshes, the model and the
 * tier in force, and the writers its second step applies through. Each is read when the popup opens or answers, never while it is drawn.
 *
 * - `scope: 'chat'`: a live chat. Its second step asks where the choice applies: THIS chat (a different model is the host's reseat,
 *   {@link ModelsSettingsPort.switchModel}; the same model with another tier is the session's tier, {@link ModelsSettingsPort.setEffort}) or
 *   NEW chats (the default, {@link ModelsSettingsPort.saveDefault}).
 * - `scope: 'home'`: the bare Home, which has no live chat: the choice is the default of new chats, and nothing is asked.
 *
 * The session's half comes from the chat's line handler (or the Home controller); the switch is the HOST's (a stand-alone chat ends its
 * driver for the rebuild, the Home swaps the chat in front), bound by {@link bindModelSwitch}. A chat whose switch is not bound has no popup.
 */
export interface ModelsSettingsPort {
  readonly scope: 'chat' | 'home';
  /** The merged catalog and its newest live refresh (a synchronous read and merge): read when the popup opens and after a refresh. May throw. */
  readonly load: () => {
    readonly entries: readonly ModelCatalogEntry[];
    readonly refreshedAt: number | undefined;
  };
  /** The refresh of empty or stale providers (ADR-0064 §5c), started as the popup's work when it opens; `undefined` when none was due. */
  readonly refreshIfStale: () => Promise<RefreshReport | undefined>;
  /** The refresh the person asks for: every connected provider, whatever its age. */
  readonly refresh: () => Promise<RefreshReport>;
  /** The model in force: the chat's bound model, or the Home's effective default (`undefined`: none set). May throw (a config read). */
  readonly current: () => string | undefined;
  /** The provider of the model in force, when the host knows it (`undefined`: the catalog row of {@link current} says it, else it is unknown). */
  readonly currentProvider: () => string | undefined;
  /** The tier in force: the chat's, or the Home's default (`undefined`: the provider's default). May throw (a config read). */
  readonly currentEffort: () => ReasoningEffort | undefined;
  /** What a person reads for a provider id (`OpenAI`, not `openai`; ADR-0145 §8). */
  readonly providerName: (provider: string) => string;
  /** The clock the catalog's age is told against (epoch milliseconds). Absent ⇒ the wall clock. */
  readonly now?: (() => number) | undefined;
  /** A chat's: switch THIS chat to another model, through the host's reseat. Called once the popup has closed. */
  readonly switchModel?: ((choice: ModelChoice) => void) | undefined;
  /** A chat's: apply a tier to THIS session, the model unchanged (`onSetEffort`: no reseat, no config write). */
  readonly setEffort?: ((effort: ReasoningEffort) => void) | undefined;
  /**
   * Save the choice as the default of new chats, through the writer that already writes it and its consent (the global `[preferences]`, the
   * config-rewrite disclosure on its visible card): started once the popup has closed (the hand-off). Absent ⇒ a chat offers no `New chats`.
   */
  readonly saveDefault?: ((choice: ModelChoice) => Promise<DefaultModelSaveResult>) | undefined;
}

/**
 * The one way a chat host binds its switch into the session's `/models` member (ADR-0059: a stand-alone chat ends its driver for the
 * rebuild, the Home swaps the chat in front): `port` with `switchModel` set when it has a chat's `/models`, else `port` itself. Both chat hosts
 * route and open with what this returns, so the routing never offers a `/models` whose `This chat` could not switch.
 */
export function bindModelSwitch(
  port: SettingsPort | undefined,
  switchModel: ((choice: ModelChoice) => void) | undefined,
): SettingsPort | undefined {
  const models = port?.models;
  if (port === undefined || models === undefined || models.scope !== 'chat') return port;
  return switchModel === undefined
    ? { ...port, models: undefined }
    : { ...port, models: { ...models, switchModel } };
}

/** What a chat says on the host's channel when its model switch could not be built: the conversation stays as it was. */
export const MODEL_SWITCH_FAILED = 'The model could not be switched; this chat stays';

/**
 * What the `/permissions` popup of a chat reads and does ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2 in a popup, ADR-0148 §10): the project's remembered commands and this session's approvals, read when the popup opens and again after a
 * withdrawal, and a withdrawal carried out (the chat's own `createPermissionsPort(…, 'chat')`: it never throws, and says what happened when it
 * could not). Only a chat has it: the bare Home's `/permissions` is the Permissions tab of its tab host.
 */
export interface PermissionsSettingsPort {
  readonly port: PermissionsPort;
  /** The mode the session is in now: what the note above the lists says a grant is worth in it. */
  readonly mode: () => ChatMode;
}

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
  readonly mode?: ModeSettingsPort | undefined;
  readonly effort?: EffortSettingsPort | undefined;
  readonly models?: ModelsSettingsPort | undefined;
  readonly permissions?: PermissionsSettingsPort | undefined;
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
    // `/mode` is a popup in a chat only: the bare Home's `/mode` sets the startup default through its own flow, whatever a port holds.
    case 'mode':
      return port.mode !== undefined && port.surface !== 'home';
    // `/models` in a chat needs the host's switch (`bindModelSwitch`): a chat that could not switch would offer a `This chat` that does nothing.
    case 'models':
      return (
        port.models !== undefined &&
        (port.models.scope === 'home' || port.models.switchModel !== undefined)
      );
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
