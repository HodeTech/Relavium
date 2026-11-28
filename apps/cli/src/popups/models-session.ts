/**
 * The `/models` popup's answers ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2,
 * §3, §5, §6; [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §5c, §10; [ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)):
 * it opens the popup over the host's popup host with what the port reads now, refreshes the catalog as the popup's work, and applies the
 * second step's form through the port's writers. Loaded with `settings-session.ts`, the first time a setting is asked for.
 *
 * **Reads.** What is in force (the model, its provider, the tier) and the catalog are read once, when the popup opens, synchronously and
 * never while a frame is drawn (the person asked: this is the key's handler), so the list opens on the model in force. A config or a
 * catalog that cannot be read is the popup's error state, never a note. The refresh of empty or stale providers is then started as the
 * popup's work (`startPopupWork`: after one macrotask, on the port's owner, a fault to the owner and never an unhandled rejection), and
 * `Enter` on the list's refresh row starts the refresh of every provider the same way; a refresh in flight takes no second one. A result lands through the popup's
 * own context, so one for a popup that is closed lands nowhere (it replaces the picker's epoch). The list says a refresh is in flight and
 * which provider it could not reach, and keeps the rows it has meanwhile: it never blocks.
 *
 * **Applies** (the second step's `Enter`; the host has checked the form is wholly on its page and the opening guard has passed). The popup
 * closes first, then:
 * - in a chat, `This chat`: a different model is the host's reseat (`switchModel`: the ADR-0059 model-switch marker and the notice of
 *   unresolved external effects are written by the reseat, as they always were); the model in force with another tier is the session's tier
 *   (`setEffort`) and says so like `/effort`; the model in force with nothing changed changes nothing, and says so;
 * - `New chats` (a chat's radio) and the bare Home: the default of new chats, through the writer that already writes it and its consent
 *   (`saveDefault`: the global `[preferences]`, the config-rewrite disclosure on its visible card), started as work once the key that applied
 *   has been handled (the hand-off); what it came to is announced, a refusal included. On the Home, the model and tier already in force
 *   write nothing.
 * Nothing is written into the transcript or a Home notice: what applied is said on the host's channel (`SettingsPort.announce`).
 */

import type { ModelCatalogEntry } from '@relavium/llm';
import type { ReasoningEffort } from '@relavium/shared';

import type { RefreshReport } from '../engine/model-refresh.js';
import type { PopupContent, PopupForm } from './frame-model.js';
import {
  alreadyDefaultAnnouncement,
  alreadyOnAnnouncement,
  choiceOf,
  currentProviderOf,
  defaultModelAnnouncement,
  markedCurrent,
  MODELS_READ_FAILED,
  MODELS_REFRESH_ROW,
  MODELS_SETTINGS_FAILED,
  MODELS_STEP,
  modelsListContent,
  modelsSpec,
  scopeForm,
  scopeOfValues,
  tierLabel,
  type CatalogStatus,
  type CatalogView,
} from './models-popup.js';
import type { PopupContext, PopupOpenResult } from './popup-host.js';
import type { PopupFormValues } from './popup-reducer.js';
import { macrotask, startPopupWork } from './popup-work.js';
import {
  effortAnnouncement,
  type ModelChoice,
  type ModelsSettingsPort,
  type SettingsOpenRequest,
  type SettingsPort,
} from './settings-port.js';

/** Why the popup could not open at all: the port lacks what it needs (a host's wiring mistake, never reachable from a typed line). */
const MISSING: PopupOpenResult = { opened: false, reason: 'closed' };

/** What is in force when the popup opens. */
interface InForce {
  readonly current: string | undefined;
  readonly provider: string | undefined;
  readonly effort: ReasoningEffort | undefined;
}

/** What the person chose on the first step: the model, the form the second step drew for it, and whether it is the model in force. */
interface Chosen {
  readonly entry: ModelCatalogEntry;
  readonly form: PopupForm;
  readonly sameModel: boolean;
}

function readInForce(models: ModelsSettingsPort): InForce | undefined {
  try {
    return {
      current: models.current(),
      provider: models.currentProvider(),
      effort: models.currentEffort(),
    };
  } catch {
    return undefined;
  }
}

/**
 * The provider new chats start on: the one the default is persisted with, else the one of the default model's catalog row; with no default
 * configured, new chats take the provider the key-aware fallback finds, which for a chat on the default agent is the chat's own (`own`).
 * `undefined`: not known (a read that failed), which the form treats as a move.
 */
function defaultProviderOf(
  models: ModelsSettingsPort,
  view: CatalogView,
  own: string | undefined,
): string | undefined {
  try {
    const persisted = models.defaultProvider?.();
    if (persisted !== undefined) return persisted;
    const model = models.defaultModel?.();
    return model === undefined ? own : currentProviderOf(view.entries, model, undefined);
  } catch {
    return undefined;
  }
}

function readCatalog(models: ModelsSettingsPort): CatalogView | undefined {
  try {
    return models.load();
  } catch {
    return undefined;
  }
}

/** What the line above the rows says after a refresh: the providers it could not reach, or the list as it is. */
function statusAfter(report: RefreshReport | undefined): CatalogStatus {
  const failed =
    report?.providers.filter((entry) => entry.status === 'failed').map((entry) => entry.provider) ??
    [];
  return failed.length > 0 ? { kind: 'failed', providers: failed } : { kind: 'idle' };
}

/**
 * Whether the form, as answered, changes nothing: the model in force, and its tier as the form opened on it (or no tier to choose). A bare
 * `Enter` chain is exactly that, so it never applies anything (ADR-0148 §3: the popup opens on the current value).
 */
function unchanged(chosen: Chosen, values: PopupFormValues): boolean {
  const tabs = chosen.form.tabs;
  return chosen.sameModel && (tabs === undefined || values.tab === tabs.initial);
}

/** `This chat`: the host's reseat for another model; the session's tier for another tier; nothing, said so, for nothing changed. */
function applyToThisChat(
  port: SettingsPort,
  models: ModelsSettingsPort,
  chosen: Chosen,
  choice: ModelChoice,
  same: boolean,
  standIn: boolean,
): void {
  if (!chosen.sameModel) {
    models.switchModel?.(choice);
    return;
  }
  const tier = choice.reasoningEffort;
  // No tier to say, or the one the form showed was only a stand-in for the provider's default and was left alone: nothing about a tier is true.
  if (tier === undefined || (same && standIn)) {
    port.announce(alreadyOnAnnouncement(choice.modelId));
    return;
  }
  if (!same) models.setEffort?.(tier);
  port.announce(effortAnnouncement(tierLabel(choice.modelId, tier), same));
}

/**
 * Whether saving `choice` as the default of new chats would change nothing in a chat: the default model, its provider and (for a model that
 * takes a tier) its tier are already the choice's. Anything not known to be the same (a port that cannot say the tier, a read that fails) is a
 * change, so the writer runs as it always did: only a default KNOWN to be the choice closes with "Already the default".
 */
function savesNothing(
  models: ModelsSettingsPort,
  view: CatalogView,
  own: string | undefined,
  choice: ModelChoice,
): boolean {
  try {
    if (models.defaultModel?.() !== choice.modelId) return false;
    if (defaultProviderOf(models, view, own) !== choice.provider) return false;
    return choice.reasoningEffort === undefined
      ? true
      : models.defaultEffort !== undefined && models.defaultEffort() === choice.reasoningEffort;
  } catch {
    return false;
  }
}

/**
 * The default of new chats: the writer's own flow, started once the key that applied has been handled to its end (its card, when the config
 * must be rewritten, is a frame of its own that no key has reached), on the port's owner; what it came to is said on the host's channel. The
 * writer's adapter never rejects; a fault that escapes it anyway is the owner's and is said as a failed save, so nobody is left without word.
 */
function handOffDefault(port: SettingsPort, models: ModelsSettingsPort, choice: ModelChoice): void {
  const save = models.saveDefault;
  if (save === undefined) return;
  startPopupWork(
    port.workOwner,
    async () => {
      await macrotask();
      const said = defaultModelAnnouncement(choice.modelId, await save(choice));
      if (said !== undefined) port.announce(said);
    },
    () => {
      const said = defaultModelAnnouncement(choice.modelId, { kind: 'refused', reason: 'failed' });
      if (said !== undefined) port.announce(said);
    },
  );
}

/** `/models`: see the module header. A refused open is said by the host in one notification. */
export function openModels(request: SettingsOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const models = port.models;
  if (models === undefined) return MISSING;
  // A chat's `This chat` needs the host's switch and the session's tier; a chat without them has no popup (the routing never sends one here).
  if (
    models.scope === 'chat' &&
    (models.switchModel === undefined || models.setEffort === undefined)
  )
    return MISSING;
  const now = models.now ?? ((): number => Date.now());
  const inForce = readInForce(models);
  const first = inForce === undefined ? undefined : readCatalog(models);
  let view: CatalogView = first ?? { entries: [], refreshedAt: undefined };
  let refreshing = false;
  let chosen: Chosen | undefined;
  const listed = (status: CatalogStatus): PopupContent =>
    modelsListContent(view, inForce?.current, status, now(), models.providerName);

  /** The first step drawn again from the catalog as it is read now, the line above it saying `status`; a read that fails is the error state. */
  const reload = (context: PopupContext, status: CatalogStatus): void => {
    if (context.signal.aborted) return;
    const read = readCatalog(models);
    if (read === undefined) {
      context.setContent(MODELS_STEP.model, MODELS_READ_FAILED);
      return;
    }
    view = read;
    context.setContent(MODELS_STEP.model, listed(status));
  };

  /** One refresh as the popup's work (none while one is in flight); `shown` when the first step already says it is refreshing. */
  const runRefresh = (
    context: PopupContext,
    refresh: () => Promise<RefreshReport | undefined>,
    shown: boolean,
  ): void => {
    if (refreshing) return;
    refreshing = true;
    if (!shown) context.setContent(MODELS_STEP.model, listed({ kind: 'refreshing' }));
    startPopupWork(
      port.workOwner,
      async () => {
        await macrotask();
        const report = await refresh();
        refreshing = false;
        reload(context, statusAfter(report));
      },
      () => {
        // A refresh the owner refused (the chat or the Home is closing) or that faulted (the owner has it): the list is drawn as it was,
        // without the line saying a refresh is in flight, and nothing is read again for it.
        refreshing = false;
        if (!context.signal.aborted)
          context.setContent(MODELS_STEP.model, listed({ kind: 'idle' }));
      },
    );
  };

  // The list opens saying a refresh is in flight (the one started below); a config or a catalog that cannot be read is the error state.
  let content: PopupContent;
  if (inForce === undefined) content = MODELS_SETTINGS_FAILED;
  else if (first === undefined) content = MODELS_READ_FAILED;
  else content = listed({ kind: 'refreshing' });
  // The popup opens on the model in force (ADR-0148 §3: a bare `Enter` chain changes nothing). A model that is in force but cannot be used now (its
  // key is gone) or is not listed has no row to stand on, and the first usable model must not stand in for it: the next `Enter` would open that
  // model's second step. It opens on the row that refreshes the list, which changes no setting.
  const marked = markedCurrent(view.entries, inForce?.current);
  const markedIsUsable = view.entries.some((entry) => entry.available && entry.modelId === marked);
  const opened = host.openForUser(
    modelsSpec(origin, models.scope, content, markedIsUsable ? marked : MODELS_REFRESH_ROW),
    {
      enter: (context, row) => {
        if (inForce === undefined || context.stepIndex() !== MODELS_STEP.model) return;
        // The list's own refresh row: every connected provider, now (one refresh at a time).
        if (row?.id === MODELS_REFRESH_ROW) {
          runRefresh(context, models.refresh, false);
          return;
        }
        const entry = view.entries.find(
          (candidate) => candidate.available && candidate.modelId === row?.id,
        );
        if (entry === undefined) return;
        const marked = markedCurrent(view.entries, inForce.current);
        const currentProvider = currentProviderOf(view.entries, inForce.current, inForce.provider);
        const form = scopeForm({
          entry,
          scope: models.scope,
          current: marked,
          currentProvider,
          defaultProvider:
            models.scope === 'home'
              ? currentProvider
              : defaultProviderOf(models, view, currentProvider),
          currentEffort: inForce.effort,
          canSaveDefault: models.saveDefault !== undefined,
          providerName: models.providerName,
        });
        chosen = { entry, form, sameModel: entry.modelId === marked };
        if (context.setContent(MODELS_STEP.scope, form)) context.goToStep(MODELS_STEP.scope);
      },
      apply: (context, values) => {
        const picked = chosen;
        if (picked === undefined) return;
        const choice = choiceOf(picked.entry, values);
        // With no tier in force (the provider's own default) the form opens on a stand-in tier; for ANOTHER model the tier the form shows is
        // the one that applies (ADR-0066 §6), but for the model in force a stand-in left alone changes nothing, and must not be said as a tier.
        const standIn =
          inForce?.effort === undefined &&
          picked.form.tabs !== undefined &&
          values.tab === picked.form.tabs.initial;
        const same = unchanged(picked, values);
        // Closed first: a reseat, a tier or a writer's card then has the screen, and the word on the hint row is drawn at once.
        context.close();
        if (scopeOfValues(models.scope, values) === 'this-chat') {
          applyToThisChat(port, models, picked, choice, same, standIn);
          return;
        }
        if (models.scope === 'home' && same) {
          port.announce(alreadyDefaultAnnouncement(choice.modelId));
          return;
        }
        // A chat's `New chats` for what already is the default of new chats changes nothing either: no write, no card, said so (OD-25).
        const own = currentProviderOf(view.entries, inForce?.current, inForce?.provider);
        if (models.scope === 'chat' && savesNothing(models, view, own, choice)) {
          port.announce(alreadyDefaultAnnouncement(choice.modelId));
          return;
        }
        // What the form shows is what is saved (ADR-0066 §6: the default model and its tier in one write), the stand-in tier included.
        handOffDefault(port, models, choice);
      },
    },
  );
  if (opened.opened && inForce !== undefined && first !== undefined)
    runRefresh(opened.context, models.refreshIfStale, true);
  return opened;
}
