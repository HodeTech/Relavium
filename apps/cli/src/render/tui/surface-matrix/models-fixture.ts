// The settings popups' code is loaded by a dynamic import the first time a setting is asked for, which a cold test process would spend longer on
// than the matrix's bounded wait for the first frame: the fixture loads it up front, so every cell sees the popup open as a warm process does.
import '../../../popups/settings-session.js';

import type { ModelCatalogEntry, ProviderId } from '@relavium/llm';
import type { ReasoningEffort } from '@relavium/shared';

import type { HomeModelsPort } from '../home-controller.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';
import type { ModelsSettingsPort, SettingsPort } from '../../../popups/settings-port.js';
import { KEYS } from './home-host.js';
import { popupBoxOf } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { Variant } from './variants.js';

/**
 * The `/models` popup in the surface matrix ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6; `popup-models-step1-80x24.png`, `popup-models-step2-80x24.png`), in the manner of `settings-fixture.ts`: a catalog of three
 * models (the one in force, one of another provider, one whose provider has no key), opened the way a person opens it (`/models` typed and
 * routed by the host), on both steps. The second step chooses the model of the other provider, so the form is drawn with its tiers, where it
 * applies and the line that says where the conversation goes, the tallest it can be: the inline page must hold it whole.
 */

/** A catalog row: a priced model with its window, its price per million in and out in dollars. */
function row(
  modelId: string,
  provider: ProviderId,
  window: number,
  input: number,
  output: number,
): ModelCatalogEntry {
  return {
    modelId,
    provider,
    displayName: modelId,
    contextWindowTokens: window,
    pricing: {
      provider,
      nativeId: modelId,
      displayName: modelId,
      contextWindowTokens: window,
      maxOutputTokens: 8192,
      inputPerMtokMicrocents: input * 100_000_000,
      outputPerMtokMicrocents: output * 100_000_000,
      cachedInputPerMtokMicrocents: input * 100_000_000,
    },
    pricingSource: 'catalog',
    priceKnown: true,
    available: true,
    deprecated: false,
  };
}

/** The model the chat is bound to (the matrix's chats are seeded with it) and the Home's default. */
export const MODELS_CURRENT = 'claude-sonnet-4-5';

/** The catalog: the model in force, a graded model of another provider, and a model whose provider has no key. */
export const MODELS_CATALOG: readonly ModelCatalogEntry[] = [
  row(MODELS_CURRENT, 'anthropic', 200_000, 3, 15),
  row('gpt-5', 'openai', 400_000, 1.25, 10),
  {
    ...row('gemini-2.5-pro', 'gemini', 1_048_576, 1.25, 10),
    available: false,
    unavailableReason: 'no-key',
  },
];

/** What each step shows once it is open. */
export const MODELS_LANDMARKS = {
  list: '3 models · 3 providers',
  form: 'Reasoning effort',
} as const;

export type ModelsState = keyof typeof MODELS_LANDMARKS;

/**
 * The row the list opens highlighted on: the model in force, named with the start of its detail, since a chat's status line also names the
 * model in force and only the list's row has the two together.
 */
export const MODELS_SELECTED_ROW = `${MODELS_CURRENT}  current`;

/** The Home's catalog port over the catalog, its default the model in force and no tier, its write recorded nowhere. */
export const homeModelsPort: HomeModelsPort = {
  load: () => ({ entries: MODELS_CATALOG, refreshedAt: undefined }),
  refreshIfStale: () => Promise.resolve(undefined),
  refresh: () => Promise.resolve({ providers: [] }),
  currentDefault: () => MODELS_CURRENT,
  currentEffort: () => undefined,
  writeDefault: () => {},
};

/**
 * A chat's settings port whose `/models` member is the session's half over the catalog: the chat bound to the model in force, a tier
 * setter and a default's writer that change nothing. The stand-alone chat binds its switch (`onReseat`); the Home's controller builds the
 * member of the chat it hosts from its own catalog port (`homeModelsPort`).
 */
export function modelsSettingsPortFor(): SettingsPort {
  let effort: ReasoningEffort | undefined;
  const models: ModelsSettingsPort = {
    scope: 'chat',
    load: homeModelsPort.load,
    refreshIfStale: homeModelsPort.refreshIfStale,
    refresh: homeModelsPort.refresh,
    current: () => MODELS_CURRENT,
    currentProvider: () => 'anthropic',
    currentEffort: () => effort,
    providerName: (id) => id,
    setEffort: (tier) => {
      effort = tier;
    },
    saveDefault: () =>
      Promise.resolve({ kind: 'saved', durability: 'confirmed', effect: 'applies' }),
  };
  return { surface: 'standalone-chat', announce: () => {}, models };
}

/** The box of the `/models` popup the host has open in this cell. */
export const modelsPopupBox = (variant: Variant, live?: PopupFrame, locked = false): PopupBox =>
  popupBoxOf(live, variant, undefined, locked);

/**
 * Put the `/models` popup of `state` on a mount of any host: `/models` typed and routed by the host; for the form, the opening guard's settle
 * passed, `↓` to the model of the other provider and `Enter`.
 */
export async function driveModels(
  m: {
    readonly key: (bytes: string) => void;
    readonly settle: () => Promise<void>;
    readonly until: (predicate: () => boolean) => Promise<boolean>;
    readonly frame: () => string[];
    readonly skip: (ms: number) => void;
  },
  type: (line: string) => Promise<void>,
  state: ModelsState,
): Promise<void> {
  const shows = (text: string) => (): boolean => m.frame().join('\n').includes(text);
  await type('/models');
  await m.until(shows(MODELS_LANDMARKS.list));
  await m.settle();
  if (state === 'list') return;
  m.skip(600);
  m.key(KEYS.down);
  await m.settle();
  m.key(KEYS.enter);
  await m.until(shows(MODELS_LANDMARKS.form));
  await m.settle();
}
