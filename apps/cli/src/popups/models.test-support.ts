/**
 * Test support for the `/models` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6): catalog rows, a `/models` member over fakes whose every call is recorded (the catalog's reads and refreshes, the switch, the tier,
 * the default's writer), a popup host on a manual clock with the popup opened on it through the opener table, and the words of the step on
 * screen. Nothing here reaches a session, a database, a config file or a network.
 */

import type { ModelCatalogEntry, ProviderId } from '@relavium/llm';
import type { ReasoningEffort } from '@relavium/shared';

import type { RefreshReport } from '../engine/model-refresh.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import { manualClock } from './doctor.test-support.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost, type PopupOpenResult } from './popup-host.js';
import { currentStep, visibleRows, type PopupKey } from './popup-reducer.js';
import type {
  DefaultModelSaveResult,
  ModelChoice,
  ModelsSettingsPort,
  SettingsPort,
  SettingsSurface,
} from './settings-port.js';
import { openSettingsPopup } from './settings-session.js';

/** A catalog row: a model priced in dollars per million in and out, with its window; override what a case cares about. */
export function model(
  modelId: string,
  provider: ProviderId,
  over: Partial<ModelCatalogEntry> & {
    readonly input?: number;
    readonly output?: number;
    readonly window?: number;
  } = {},
): ModelCatalogEntry {
  const { input = 3, output = 15, window = 200_000, ...rest } = over;
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
      inputPerMtokMicrocents: Math.round(input * 100_000_000),
      outputPerMtokMicrocents: Math.round(output * 100_000_000),
      cachedInputPerMtokMicrocents: Math.round(input * 100_000_000),
    },
    pricingSource: 'catalog',
    priceKnown: true,
    available: true,
    deprecated: false,
    ...rest,
  };
}

/** The model a chat is bound to in these tests: a graded Anthropic model (every tier a choice). */
export const GRADED = 'claude-sonnet-4-6';
/** A budget model (`off` and `on`). */
export const BUDGET = 'claude-sonnet-4-5';
/** A graded OpenAI model (`low`, `medium`, `high`). */
export const OPENAI = 'gpt-5';
/** A model with no tier to choose. */
export const NO_TIER = 'gpt-4o';

/** The catalog of these tests: the graded model in force, a budget model, two OpenAI models, and a model whose provider has no key. */
export const CATALOG: readonly ModelCatalogEntry[] = [
  model(GRADED, 'anthropic'),
  model(BUDGET, 'anthropic'),
  model(OPENAI, 'openai', { input: 1.25, output: 10, window: 400_000 }),
  model(NO_TIER, 'openai', { input: 2.5, output: 10, window: 128_000 }),
  model('gemini-2.5-pro', 'gemini', { available: false, unavailableReason: 'no-key' }),
];

/** A promise and the functions that settle it. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** What a fake `/models` member is built from; everything left out is the chat bound to {@link GRADED} at `medium`, every writer wired. */
export interface FakeModelsOptions {
  readonly scope?: 'chat' | 'home';
  readonly entries?: readonly ModelCatalogEntry[];
  readonly refreshedAt?: number;
  readonly current?: string | undefined;
  readonly provider?: string | undefined;
  /** The default model new chats start with (a chat's port reads it; absent ⇒ the port has none). */
  readonly defaultModel?: string | undefined;
  /** The provider the default is persisted with (`[chat].default_provider`; absent ⇒ none persisted). */
  readonly defaultProvider?: string | undefined;
  readonly effort?: ReasoningEffort | undefined;
  /** The catalog read throws. */
  readonly loadThrows?: boolean;
  /** What is in force cannot be read. */
  readonly currentThrows?: boolean;
  /** The chat cannot save a default (no writer). */
  readonly noWriter?: boolean;
  /** No switch is bound (a chat whose host did not bind one). */
  readonly noSwitch?: boolean;
  /** No tier setter (a chat session without one). */
  readonly noSetter?: boolean;
  /** What the default's writer comes to (default: saved, applies). */
  readonly save?: (choice: ModelChoice) => Promise<DefaultModelSaveResult>;
}

/** A `/models` member over fakes: every call is recorded in order, and the two refreshes are deferred so a test settles them itself. */
export function fakeModels(options: FakeModelsOptions = {}) {
  const calls: string[] = [];
  const switched: ModelChoice[] = [];
  const tiers: ReasoningEffort[] = [];
  const saved: ModelChoice[] = [];
  let entries = options.entries ?? CATALOG;
  let effort = options.effort === undefined && !('effort' in options) ? 'medium' : options.effort;
  const stale: ReturnType<typeof deferred<RefreshReport | undefined>>[] = [];
  const forced: ReturnType<typeof deferred<RefreshReport>>[] = [];
  const member: ModelsSettingsPort = {
    scope: options.scope ?? 'chat',
    load: () => {
      calls.push('load');
      if (options.loadThrows === true) throw new Error('the catalog database is locked');
      return { entries, refreshedAt: options.refreshedAt };
    },
    refreshIfStale: () => {
      calls.push('refreshIfStale');
      const next = deferred<RefreshReport | undefined>();
      stale.push(next);
      return next.promise;
    },
    refresh: () => {
      calls.push('refresh');
      const next = deferred<RefreshReport>();
      forced.push(next);
      return next.promise;
    },
    current: () => {
      if (options.currentThrows === true) throw new Error('the config does not parse');
      return 'current' in options ? options.current : GRADED;
    },
    currentProvider: () => ('provider' in options ? options.provider : 'anthropic'),
    ...('defaultModel' in options ? { defaultModel: () => options.defaultModel } : {}),
    ...('defaultProvider' in options ? { defaultProvider: () => options.defaultProvider } : {}),
    currentEffort: () => {
      if (options.currentThrows === true) throw new Error('the config does not parse');
      return effort;
    },
    providerName: (id) => ({ anthropic: 'Anthropic', openai: 'OpenAI' })[id] ?? id,
    now: () => Date.UTC(2026, 10, 25, 12, 0, 0),
    ...(options.noSwitch === true || (options.scope ?? 'chat') === 'home'
      ? {}
      : {
          switchModel: (choice: ModelChoice) => {
            calls.push('switch');
            switched.push(choice);
          },
        }),
    ...((options.scope ?? 'chat') === 'home' || options.noSetter === true
      ? {}
      : {
          setEffort: (tier: ReasoningEffort) => {
            calls.push('setEffort');
            tiers.push(tier);
            effort = tier;
          },
        }),
    ...(options.noWriter === true
      ? {}
      : {
          saveDefault: (choice: ModelChoice) => {
            calls.push('saveDefault');
            saved.push(choice);
            return (
              options.save?.(choice) ??
              Promise.resolve<DefaultModelSaveResult>({
                kind: 'saved',
                durability: 'confirmed',
                effect: 'applies',
              })
            );
          },
        }),
  };
  return {
    member,
    calls,
    switched,
    tiers,
    saved,
    stale,
    forced,
    /** Change what the next catalog read returns (a refresh that added or dropped a model). */
    setEntries: (next: readonly ModelCatalogEntry[]) => {
      entries = next;
    },
  };
}

export const ENTER: PopupKey = { return: true };
export const ESC: PopupKey = { escape: true };
export const DOWN: PopupKey = { downArrow: true };
export const UP: PopupKey = { upArrow: true };
export const LEFT: PopupKey = { leftArrow: true };
export const RIGHT: PopupKey = { rightArrow: true };

/** Let the popup's work run: a macrotask (its own wait), then the microtasks after it. */
export async function settleWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A popup host on a manual clock with its frame "on screen" (a page and a row of the floor's alternate screen, unless given), and `/models`
 * opened on it through the opener table over `member`.
 */
export function modelsRig(
  member: ModelsSettingsPort | undefined,
  options: {
    readonly pageRows?: number;
    readonly innerWidth?: number;
    readonly surface?: SettingsSurface;
    /** The owner refuses to admit work (the host is closing): its `enter` throws. */
    readonly refuseEntry?: boolean;
  } = {},
) {
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
  host.bindPageRows(() => options.pageRows ?? 17);
  host.bindInnerWidth(() => options.innerWidth ?? 66);
  const announced: string[] = [];
  const failures: unknown[] = [];
  /** How many operations the owner admitted. */
  const entered: number[] = [];
  const port: SettingsPort = {
    surface: options.surface ?? (member?.scope === 'home' ? 'home' : 'standalone-chat'),
    announce: (text) => {
      announced.push(text);
      notifications.notify(text);
    },
    workOwner: {
      enter: <T>(operation: () => Promise<T>) => {
        if (options.refuseEntry === true) throw new Error('the host is closing');
        entered.push(entered.length);
        return operation();
      },
      failure: (cause: unknown) => {
        failures.push(cause);
      },
    },
    ...(member === undefined ? {} : { models: member }),
  };
  const open = (): PopupOpenResult =>
    openSettingsPopup({
      host,
      port,
      command: 'models',
      origin: member?.scope === 'home' ? 'home' : 'chat',
    });
  return {
    host,
    clock,
    notifications,
    announced,
    failures,
    entered,
    port,
    open,
    /** The popup has appeared and its settle time has passed: an answer may count. */
    settle: (): void => {
      host.shown(host.getSnapshot());
      // Past the opening guard's settle AND the form's lockout after the answer that reached it (`popup-host.ts`: a form's `Enter` waits out
      // `APPROVAL_LOCKOUT_MS` so a held key's first repeat cannot apply it), so the `Enter` pressed next is a deliberate one.
      clock.advance(APPROVAL_LOCKOUT_MS + 100);
    },
    press: (input: string, key: PopupKey = {}): boolean => host.input(input, key),
    /** The step the popup is on, its content and the highlighted row's id, or `undefined` once it is closed. */
    step: () => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return undefined;
      const { state } = currentStep(frame);
      return {
        index: frame.stepIndex,
        content: state.content,
        highlighted: visibleRows(state)[state.selected]?.id,
        rows: visibleRows(state).map((row) => row.id),
        state,
      };
    },
  };
}
