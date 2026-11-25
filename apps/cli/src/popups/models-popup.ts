/**
 * The `/models` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §5,
 * §6; [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §6, §10; [ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md);
 * MVP-11 §4.4, `popup-models-step1-80x24.png` and `popup-models-step2-80x24.png`): two steps, `Model` and `Effort & scope`.
 *
 * - **Model**: the merged catalog as a list, typed into to filter it, opened on the model in force so a bare `Enter` changes nothing. A row is
 *   the model's id, then the model in force marked `current`, its context window, its price per million tokens in and out (or that a cost cap
 *   will not apply), its provider and a deprecated flag. After the models it can use, one row refreshes the list. A model this person cannot
 *   use is drawn dim under its own heading with why (ADR-0064 §6: dimmed, never hidden), and cannot be chosen. A line above the rows says how
 *   many there are and how fresh the list is, or that it is being refreshed, or which provider could not be refreshed (the refresh never
 *   blocks: ADR-0064 §5c).
 * - **Effort & scope**: a form: what the model is (one line), its reasoning tiers when it takes any (the same control as `/effort`), and in a
 *   chat where the choice applies (this chat, or the default of new chats). When this chat would move to another provider the form says what
 *   is sent there before `Enter` (ADR-0059, MVP-11 rule 13).
 *
 * Pure builders: the rows, the contents, the spec, the form and the words a choice announces. The state machine that answers the keys is
 * `models-session.ts`; neither is loaded until the person first opens a setting (`settings-port.ts`).
 *
 * **Every string a catalog, a provider or a model wrote is scrubbed** (`scrubPopupText`: secrets, control and bidirectional characters, host
 * glyphs, answer chords and key tokens), whether it is drawn, filtered on or announced: a live model id or display name is a provider's text.
 */

import { datedPinBase, type ModelCatalogEntry } from '@relavium/llm';
import type { ReasoningEffort } from '@relavium/shared';

import { effortRowLabel, effortTiersFor, projectEffortToRow } from '../chat/effort-notice.js';
import { formatPricePair, formatRefreshed } from '../render/notation.js';
import type {
  PopupContent,
  PopupForm,
  PopupFormOption,
  PopupHeading,
  PopupListRow,
  PopupOrigin,
} from './frame-model.js';
import type { PopupFormValues, PopupSpec } from './popup-reducer.js';
import { fitNotice, scrubPopupText } from './popup-text.js';
import type { DefaultModelSaveResult, ModelChoice } from './settings-port.js';

/** The two steps, by index. */
export const MODELS_STEP = { model: 0, scope: 1 } as const;

/**
 * The id of the list's own row that refreshes it: `Enter` on it asks every connected provider for its models now, whatever their age (the
 * picker's `Ctrl+R`; a row, because the popup host answers a letter or `Enter` and a letter is the filter's). A NUL no provider's model id
 * holds, so it is never a model.
 */
export const MODELS_REFRESH_ROW = '\u0000refresh';

/** The id of the heading row above the models this person cannot use (never an `Enter` answer: a heading is not `enabled`). */
const UNAVAILABLE_SECTION_ID = 'unavailable-section';

// ── the formatters the picker had ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A model's price: `$in / $out per M` (the one per-million notation of `render/notation.ts`, every digit the price has) from the effective
 * (user or catalog) pricing, or ADR-0064 §6's honest `no price — cost cap will not apply` when it is unknown: a session cap cannot bound it.
 */
export function formatModelPrice(entry: ModelCatalogEntry): string {
  if (!entry.priceKnown || entry.pricing === undefined) return 'no price — cost cap will not apply';
  const { inputPerMtokMicrocents, outputPerMtokMicrocents } = entry.pricing;
  return formatPricePair(inputPerMtokMicrocents, outputPerMtokMicrocents);
}

/**
 * A compact context window (`200K ctx`, `1M ctx`, `1.5M ctx`), or `''` when it is unknown. A size is rounded ONCE, to the nearest thousand and,
 * from a million up, to the nearest tenth of a million: `999,500`, `1,000,000` and `1,048,576` all read `1M ctx` (a `1000K ctx` and a
 * `1.0M ctx` next to a `1M ctx` read as three sizes).
 */
export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens < 1000) return `${String(tokens)} ctx`;
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${String(thousands)}K ctx`;
  const tenths = Math.round(tokens / 100_000);
  const rest = tenths % 10;
  return `${String(Math.floor(tenths / 10))}${rest === 0 ? '' : `.${String(rest)}`}M ctx`;
}

/**
 * The providers a refresh could not reach, as one secret-free line (ADR-0064 §8: a failure is visible and not fatal), or `undefined` when
 * none failed. Only the providers' names are joined (by `providerName`, `OpenAI` and not `openai`; ADR-0145 §8), never an error's text.
 */
export function partialFailureBanner(
  failedProviders: readonly string[],
  providerName: (id: string) => string,
): string | undefined {
  if (failedProviders.length === 0) return undefined;
  return `couldn't refresh ${failedProviders.map(providerName).join(', ')} — showing last-known models`;
}

// ── the first step ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the line above the rows says: the list as it is, a refresh in flight, or the providers the last refresh could not reach. */
export type CatalogStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'refreshing' }
  | { readonly kind: 'failed'; readonly providers: readonly string[] };

/** The catalog as the port reads it. */
export interface CatalogView {
  readonly entries: readonly ModelCatalogEntry[];
  readonly refreshedAt: number | undefined;
}

/**
 * The row that stands for the model in force: its own id, or, for a dated pin the catalog collapsed onto its rolling alias (ADR-0064's
 * alias/pin dedup: one model, resolved by either id), the alias. `undefined` when neither is listed (or nothing is in force).
 */
export function markedCurrent(
  entries: readonly ModelCatalogEntry[],
  current: string | undefined,
): string | undefined {
  if (current === undefined) return undefined;
  const ids = new Set(entries.map((entry) => entry.modelId));
  if (ids.has(current)) return current;
  const alias = datedPinBase(current);
  return alias !== undefined && ids.has(alias) ? alias : undefined;
}

/** The provider of the model in force: what the host knows, else the provider of its row. `undefined`: neither says. */
export function currentProviderOf(
  entries: readonly ModelCatalogEntry[],
  current: string | undefined,
  known: string | undefined,
): string | undefined {
  if (known !== undefined) return known;
  const marked = markedCurrent(entries, current);
  return entries.find((entry) => entry.modelId === marked)?.provider;
}

/** The words of a row after its id: the model in force first (never cut), then its size, its price, its provider and a deprecated flag. */
function rowFacts(
  entry: ModelCatalogEntry,
  isCurrent: boolean,
  providerName: (id: string) => string,
): string[] {
  const ctx = formatContextWindow(entry.contextWindowTokens);
  return [
    ...(isCurrent ? ['current'] : []),
    ...(ctx.length > 0 ? [ctx] : []),
    formatModelPrice(entry),
    scrubPopupText(providerName(entry.provider)),
    ...(entry.deprecated ? ['deprecated'] : []),
  ];
}

/** Why a model this person cannot use is dim: its provider has no key (`no key for OpenAI`), or the key's own list does not have it. */
function unavailableReason(entry: ModelCatalogEntry, providerName: (id: string) => string): string {
  const provider = scrubPopupText(providerName(entry.provider));
  return entry.unavailableReason === 'no-key'
    ? `no key for ${provider}`
    : `${provider} · unavailable on your key`;
}

/**
 * The rows of the catalog, in the catalog's own order (the models this person can use first, each group by name: ADR-0064 §6 and the 2.5.G
 * ruling): a model is its id (scrubbed) and its facts; then the row that refreshes the list ({@link MODELS_REFRESH_ROW}); the models that
 * cannot be used come after a heading that says how to get one, each dim with why. The model in force is marked `current` wherever it is. A
 * row's `id` is the model's own id, never drawn.
 */
export function modelRows(
  entries: readonly ModelCatalogEntry[],
  current: string | undefined,
  providerName: (id: string) => string,
): PopupListRow[] {
  const marked = markedCurrent(entries, current);
  const usable = entries.filter((entry) => entry.available);
  const unusable = entries.filter((entry) => !entry.available);
  const rows: PopupListRow[] = usable.map((entry) => ({
    id: entry.modelId,
    label: scrubPopupText(entry.modelId),
    detail: rowFacts(entry, entry.modelId === marked, providerName).join(' · '),
    // A model is also found by the name its provider gives it (`Sonnet 4.6`), which the row does not draw.
    match: scrubPopupText(entry.displayName),
  }));
  // Pinned: the row that refreshes the list stays reachable while a filter is typed (it was `Ctrl+R` on the picker this popup replaced).
  rows.push({
    id: MODELS_REFRESH_ROW,
    label: 'Refresh the list',
    detail: 'ask every connected provider again',
    pinned: true,
  });
  if (unusable.length > 0)
    rows.push({
      id: UNAVAILABLE_SECTION_ID,
      label: 'Unavailable: /providers on the Home connects a key',
      section: true,
      enabled: false,
    });
  for (const entry of unusable) {
    const isCurrent = entry.modelId === marked;
    rows.push({
      id: entry.modelId,
      label: scrubPopupText(entry.modelId),
      // The facts stay on the row for the filter (a provider's name finds its models), and the reason is what is drawn.
      detail: rowFacts(entry, isCurrent, providerName).join(' · '),
      match: scrubPopupText(entry.displayName),
      enabled: false,
      reason: `${isCurrent ? 'current · ' : ''}${unavailableReason(entry, providerName)}`,
    });
  }
  return rows;
}

/** `1 model`, `12 models`. */
function counted(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? '' : 's'}`;
}

/** The line above the rows: how many models from how many providers and how fresh, a refresh in flight, or the providers it could not reach. */
export function catalogHeading(
  view: CatalogView,
  status: CatalogStatus,
  nowMs: number,
  providerName: (id: string) => string,
): PopupHeading {
  if (status.kind === 'failed') {
    const banner = partialFailureBanner(status.providers, (id) => scrubPopupText(providerName(id)));
    if (banner !== undefined) return { status: 'warning', statusWord: 'warning', text: banner };
  }
  const providers = new Set(view.entries.map((entry) => entry.provider)).size;
  const size = `${counted(view.entries.length, 'model')} · ${counted(providers, 'provider')}`;
  if (status.kind === 'refreshing')
    return { status: 'running', statusWord: 'running', text: `${size} · refreshing…` };
  return view.refreshedAt === undefined
    ? { status: 'pending', statusWord: 'pending', text: `${size} · never refreshed` }
    : {
        status: 'completed',
        statusWord: 'completed',
        text: `${size} · ${formatRefreshed(view.refreshedAt, nowMs)}`,
      };
}

/** What the list says while the catalog is first read (an empty cache that a refresh is filling). */
export const MODELS_LOADING: PopupContent = { kind: 'loading', what: 'Reading the model list' };

/** The catalog has no model at all: what is empty, and what to do in the TUI (a provider is connected from the Home). */
export function modelsEmptyContent(): PopupContent {
  return {
    kind: 'empty',
    what: 'No models yet.',
    next: 'Connect a provider with /providers on the Home, then open /models again.',
  };
}

/** The catalog could not be read (a database fault): said by its kind, never its message. */
export const MODELS_READ_FAILED: PopupContent = {
  kind: 'error',
  what: 'Could not read the model catalog.',
  next: 'Close this and open /models again.',
};

/** What is in force could not be read (a configuration that does not parse): the popup offers nothing it could apply against it. */
export const MODELS_SETTINGS_FAILED: PopupContent = {
  kind: 'error',
  what: 'Could not read the chat settings.',
  next: 'Fix the configuration, then open /models again.',
};

/** The first step's content for the catalog as read: its rows under their heading, or the empty state. */
export function modelsListContent(
  view: CatalogView,
  current: string | undefined,
  status: CatalogStatus,
  nowMs: number,
  providerName: (id: string) => string,
): PopupContent {
  if (view.entries.length === 0)
    return status.kind === 'refreshing' ? MODELS_LOADING : modelsEmptyContent();
  return {
    kind: 'list',
    heading: catalogHeading(view, status, nowMs, providerName),
    rows: modelRows(view.entries, current, providerName),
  };
}

// ── the second step ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the second step is built from: the model chosen, where the popup runs, and what is in force. */
export interface ScopeFacts {
  readonly entry: ModelCatalogEntry;
  /** `chat`: a live chat (the radio, when the chat can save a default); `home`: the bare Home (the choice is the default of new chats). */
  readonly scope: 'chat' | 'home';
  /** The model in force, as its row is marked ({@link markedCurrent}). */
  readonly current: string | undefined;
  /** The provider of the model in force ({@link currentProviderOf}); `undefined`: unknown, and the warning says where the data goes anyway. */
  readonly currentProvider: string | undefined;
  readonly currentEffort: ReasoningEffort | undefined;
  /** A chat that can save the default (its port has a writer): the radio offers `New chats`. */
  readonly canSaveDefault: boolean;
  readonly providerName: (id: string) => string;
}

/** The radio's two options, by id. */
export const SCOPE_THIS_CHAT = 'chat';
export const SCOPE_NEW_CHATS = 'new';

/** One line that names the model chosen: its id, its size, its price and its provider. */
function summaryOf(entry: ModelCatalogEntry, providerName: (id: string) => string): string {
  const ctx = formatContextWindow(entry.contextWindowTokens);
  const facts = [
    ...(ctx.length > 0 ? [ctx] : []),
    formatModelPrice(entry),
    scrubPopupText(providerName(entry.provider)),
  ];
  return `${scrubPopupText(entry.modelId)}  ${facts.join(' · ')}`;
}

/**
 * The tiers of the model chosen, as the `/effort` popup offers them (`effortTiersFor`: a tier the provider would refuse is no option; a budget
 * model's `medium` reads `on`), opened on the tier in force projected onto the option that represents it (the neutral `medium` when none is),
 * or `undefined` for a model that takes none.
 */
function tiersField(facts: ScopeFacts): PopupForm['tabs'] {
  const model = facts.entry.modelId;
  const tiers = effortTiersFor(model);
  if (tiers.length === 0) return undefined;
  return {
    label: 'Reasoning effort',
    verb: 'effort',
    options: tiers.map((tier) => ({ id: tier, label: effortRowLabel(model, tier).label })),
    initial: projectEffortToRow(model, tiers, facts.currentEffort ?? 'medium'),
  };
}

/**
 * The data-leaves line ([ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md), MVP-11 rule 13): said before `Enter`
 * when the chosen model's provider is not the one in force (and when the one in force is not known: it may not be). In a chat it is about
 * THIS conversation, which the reseat carries (the text you sent and the content-free tool receipts); on the Home it is about the chats to
 * come. The provider names are scrubbed.
 */
export function dataLeavesWarning(
  where: 'this-chat' | 'new-chats',
  from: string | undefined,
  to: string,
  providerName: (id: string) => string,
): string | undefined {
  if (from === to) return undefined;
  const target = scrubPopupText(providerName(to));
  const origin = from === undefined ? undefined : scrubPopupText(providerName(from));
  if (where === 'this-chat')
    return origin === undefined
      ? `This chat moves to ${target}. Your messages and short tool receipts are sent to ${target}.`
      : `This chat moves from ${origin} to ${target}. Your messages and short tool receipts are sent to ${target}.`;
  return origin === undefined
    ? `New chats start on ${target}. Your messages in them are sent to ${target}.`
    : `New chats move from ${origin} to ${target}. Your messages in them are sent to ${target}.`;
}

/** What `This chat` does with the model chosen: switch to it, set its tier, or, for the model in force with no tier, nothing. */
function thisChatDetail(facts: ScopeFacts, hasTiers: boolean): string {
  if (facts.entry.modelId !== facts.current)
    return 'switches the model now; the conversation stays';
  return hasTiers
    ? 'applies the effort now; the conversation stays'
    : 'keeps this model; nothing changes';
}

/**
 * The second step's form (`popup-models-step2-80x24.png`): the summary line, the tiers when the model takes any, and in a chat the radio
 * (`This chat`, opened on when the provider is the one in force and `New chats` when it is not, which the chat offers when it can save a
 * default), with the data-leaves line on `This chat` when the provider changes; on the Home no radio, and the line about new chats as the form's own warning.
 */
export function scopeForm(facts: ScopeFacts): PopupForm {
  const tabs = tiersField(facts);
  const summary = summaryOf(facts.entry, facts.providerName);
  if (facts.scope === 'home')
    return {
      kind: 'form',
      summary,
      tabs,
      warning: dataLeavesWarning(
        'new-chats',
        facts.currentProvider,
        facts.entry.provider,
        facts.providerName,
      ),
    };
  const thisChat: PopupFormOption = {
    id: SCOPE_THIS_CHAT,
    label: 'This chat',
    detail: thisChatDetail(facts, tabs !== undefined),
    warning:
      facts.entry.modelId === facts.current
        ? undefined
        : dataLeavesWarning(
            'this-chat',
            facts.currentProvider,
            facts.entry.provider,
            facts.providerName,
          ),
  };
  const newChats: PopupFormOption = {
    id: SCOPE_NEW_CHATS,
    label: 'New chats',
    detail: 'saves it as your default; this chat stays',
    // The chats to come start on the other provider: said as the Home says it (it is the scope a provider change opens on).
    warning: dataLeavesWarning(
      'new-chats',
      facts.currentProvider,
      facts.entry.provider,
      facts.providerName,
    ),
  };
  return {
    kind: 'form',
    summary,
    tabs,
    radio: facts.canSaveDefault
      ? {
          label: 'Apply to',
          // Not the frame's `apply to` (`/mode`'s verb): with it this step's legend in a chat is 67 columns, one more than a popup at the floor
          // holds, and `[Ctrl+C] close` would be dropped there; with `scope` every key of it is named (`models-popup.test.ts` pins the width).
          verb: 'scope',
          // ADR-0148 §3: when the provider changes the scope is NOT pre-selected to "this chat" (the conversation would go to another provider on
          // an `Enter`): the default for new chats is, which sends no conversation anywhere. Within one provider the default is the chat.
          initial:
            facts.currentProvider === facts.entry.provider ? SCOPE_THIS_CHAT : SCOPE_NEW_CHATS,
          options: [thisChat, newChats],
        }
      : undefined,
    // A chat that cannot save a default has no radio: `Enter` applies to this chat, and the line about it is the form's own.
    warning: facts.canSaveDefault ? undefined : thisChat.warning,
  };
}

/** The placeholder of the second step before a model is chosen (it is never drawn: the first step's `Enter` fills it before moving there). */
const SCOPE_PLACEHOLDER: PopupContent = {
  kind: 'empty',
  what: 'No model is chosen yet.',
  next: 'Choose one on the first step.',
};

/**
 * The popup's spec: the list, typed into to filter it, opened on the model in force (`initialRow`), `Enter` goes on to the second step (or,
 * on the refresh row, refreshes); the form, whose `Enter` applies (in a chat) or sets the default (on the Home). `Esc` steps back from the
 * second step and closes from the first; `Ctrl+C` closes.
 */
export function modelsSpec(
  origin: PopupOrigin,
  scope: 'chat' | 'home',
  content: PopupContent,
  initialRow: string | undefined,
): PopupSpec {
  return {
    id: 'models',
    title: '/models',
    origin,
    steps: [
      {
        name: 'Model',
        content,
        enter: 'next',
        filter: true,
        initialRow,
        legendKeep: ['Enter'],
      },
      {
        name: 'Effort & scope',
        content: SCOPE_PLACEHOLDER,
        enter: scope === 'home' ? 'set default' : 'apply',
        legendKeep: ['Enter'],
      },
    ],
  };
}

/** What the form was answered with: the model chosen, and the tier when its tabs offered one. */
export function choiceOf(entry: ModelCatalogEntry, values: PopupFormValues): ModelChoice {
  const tiers = effortTiersFor(entry.modelId);
  const tier = tiers.find((candidate) => candidate === values.tab);
  return {
    modelId: entry.modelId,
    provider: entry.provider,
    ...(tier === undefined ? {} : { reasoningEffort: tier }),
  };
}

/** Where the form applies: the radio's choice, or this chat in a chat with no radio, or the default on the Home. */
export function scopeOfValues(
  scope: 'chat' | 'home',
  values: PopupFormValues,
): 'this-chat' | 'new-chats' {
  if (scope === 'home') return 'new-chats';
  return values.radio === SCOPE_NEW_CHATS ? 'new-chats' : 'this-chat';
}

// ── what a choice announces (the host's channel, at most 54 columns) ────────────────────────────────────────────────────────

/**
 * What saving the default of new chats says, by its result (`undefined`: the host is closing, and nothing is said): the model and where it
 * applies, or why it does not apply here, or why it was not saved. The id is scrubbed; a long id falls back to a shorter sentence, then is cut.
 */
export function defaultModelAnnouncement(
  modelId: string,
  result: DefaultModelSaveResult,
): string | undefined {
  const id = scrubPopupText(modelId);
  if (result.kind === 'refused') {
    switch (result.reason) {
      case 'symlink':
        return 'Default not saved: the config is a symbolic link';
      case 'failed':
        return 'The default model could not be saved';
      case 'cancelled':
        return 'Default model unchanged';
      case 'closing':
        return undefined;
    }
  }
  if (result.effect === 'overridden')
    return 'Saved as default; a project or workspace overrides it';
  if (result.effect === 'unknown') return 'Saved as default; the config could not be read back';
  if (result.durability === 'unconfirmed') return 'Default model saved; durability unconfirmed';
  return fitNotice(`Default model: ${id} · applies to new chats`, `Default for new chats: ${id}`);
}

/** What `Enter` says when it changed nothing in a chat: the model in force, chosen again with nothing else to set. */
export function alreadyOnAnnouncement(modelId: string): string {
  return fitNotice(`Already on ${scrubPopupText(modelId)}.`);
}

/** What `Enter` says on the Home when the model chosen, with its tier, is already the default of new chats: nothing is written. */
export function alreadyDefaultAnnouncement(modelId: string): string {
  return fitNotice(`Already the default: ${scrubPopupText(modelId)}`);
}

/** The label of `tier` for `modelId` (`on` for a budget model's `medium`), for the tier announcement of `/effort` (`effortAnnouncement`). */
export function tierLabel(modelId: string, tier: ReasoningEffort): string {
  return effortRowLabel(modelId, tier).label;
}
