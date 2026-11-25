// The settings popups' code is loaded by a dynamic import the first time a setting is asked for, which a cold test process would spend longer on
// than the matrix's bounded wait for the first frame: the fixture loads it up front, so every cell sees the popup open as a warm process does.
import '../../../popups/settings-session.js';

import type { ChatMode, ReasoningEffort } from '@relavium/shared';

import { effortTiersFor } from '../../../chat/effort-notice.js';
import { MODE_EFFECT } from '../../../chat/mode-effects.js';
import type { PopupOrigin } from '../../../popups/frame-model.js';
import type { PopupFrame, PopupSpec } from '../../../popups/popup-reducer.js';
import type { SettingsPort, SettingsSurface } from '../../../popups/settings-port.js';
import { KEYS } from './home-host.js';
import { popupBoxOf } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { Variant } from './variants.js';

/**
 * The settings popups in the surface matrix ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6), in the manner of `report-fixture.ts`: the `/effort` popup over a settings port of fakes, opened the way a person opens it (the
 * command typed, the chat host's own routing), and two popups of the TEST layer that put the host's two settings bodies on every host and cell
 * before the product commands that use them are popups: a form (the `/models` second step's body, `popup-models-step2-80x24.png`) and a list
 * whose rows state their effect (the `/mode` first step's body, `popup-mode-chat-80x24.png`). Neither test popup is a product command (their
 * titles are no command's name).
 */

/** The model the `/effort` cell is bound to: a graded model, so every tier is a row. */
export const SETTINGS_MODEL = 'claude-sonnet-4-6';

/** What each settings surface shows once it is open. */
export const SETTINGS_LANDMARKS = {
  effort: 'balanced reasoning · current',
  form: 'Reasoning effort',
  effect: 'Granted actions are approved',
  mode: 'every action asks first · current',
  'mode-apply': 'Mode: auto',
} as const;

export type SettingsState = keyof typeof SETTINGS_LANDMARKS;

/** The legend row of each settings surface, whole on one row of every cell. */
export const SETTINGS_LEGEND_ROW: Readonly<Record<SettingsState, string>> = {
  effort: '↑/↓ select · Enter apply · Esc close',
  form: '←/→ effort · ↑/↓ scope · Enter apply · [Ctrl+C] close · Esc back',
  effect: '↑/↓ select · Enter apply · Esc close',
  mode: '↑/↓ select · Enter next · Esc close',
  'mode-apply': '↑/↓ apply to · Enter apply · [Ctrl+C] close · Esc back',
};

/** A settings port for one cell: `/effort` over the bound model's real tiers, the tier in force `medium`, and an apply that records. */
export function settingsPortFor(surface: SettingsSurface): SettingsPort {
  let current: ReasoningEffort | undefined = 'medium';
  let mode: ChatMode = 'ask';
  return {
    surface,
    announce: () => {},
    effort: {
      model: () => SETTINGS_MODEL,
      tiers: () => effortTiersFor(SETTINGS_MODEL),
      current: () => current,
      apply: (effort) => {
        current = effort;
      },
    },
    // `/mode` (the two steps of `popup-mode-chat-80x24.png`): the mode in force `ask`; applying moves it, the hand-off does nothing here.
    mode: {
      current: () => mode,
      apply: (next) => {
        mode = next;
        return true;
      },
      saveStartupDefault: () => Promise.resolve({ kind: 'unchanged' }),
    },
  };
}

/** The title of the test layer's form popup. */
export const TEST_FORM_TITLE = 'Test form';

/** A form popup of the test layer: a first step with one row, and the form as its second step, opened on it (as `/models` opens step 2). */
export function testFormPopup(origin: PopupOrigin): PopupSpec {
  return {
    id: 'test-form',
    title: TEST_FORM_TITLE,
    origin,
    initialStep: 1,
    steps: [
      { name: 'Model', content: { kind: 'list', rows: [{ id: 'gpt-5', label: 'gpt-5' }] } },
      {
        name: 'Effort & scope',
        enter: 'apply',
        legendKeep: ['Enter'],
        content: {
          kind: 'form',
          summary: 'gpt-5  400k context · $1.25 / $10 per M · openai',
          tabs: {
            label: 'Reasoning effort',
            verb: 'effort',
            initial: 'medium',
            options: ['low', 'medium', 'high'].map((id) => ({ id, label: id })),
          },
          radio: {
            label: 'Apply to',
            verb: 'scope',
            initial: 'chat',
            options: [
              {
                id: 'chat',
                label: 'This chat',
                detail: 'switches the model now; the conversation stays',
                warning:
                  'This chat moves from Anthropic to OpenAI. Your messages and short tool receipts are sent to OpenAI.',
              },
              {
                id: 'new',
                label: 'New chats',
                detail: 'saves it as your default; this chat stays',
              },
            ],
          },
        },
      },
    ],
  };
}

/** The title of the test layer's list popup whose rows state their effect. */
export const TEST_EFFECT_TITLE = 'Test effect';

/** A list popup of the test layer whose rows state their effect (the highlighted row's under the list, the room of the longest kept). */
export function testEffectPopup(origin: PopupOrigin): PopupSpec {
  return {
    id: 'test-effect',
    title: TEST_EFFECT_TITLE,
    origin,
    steps: [
      {
        name: 'Mode',
        enter: 'apply',
        initialRow: 'auto',
        content: {
          kind: 'list',
          rows: [
            { id: 'ask', label: 'ask', detail: 'asks before every effect' },
            { id: 'plan', label: 'plan', detail: 'only reads' },
            {
              id: 'auto',
              label: 'auto',
              detail: 'approves granted actions',
              effect:
                'Granted actions are approved without asking; a command still asks unless you remembered or approved it.',
            },
          ],
        },
      },
    ],
  };
}

/** The box of the settings popup the host has open in this cell. */
export const settingsPopupBox = (variant: Variant, live?: PopupFrame): PopupBox =>
  popupBoxOf(live, variant);

/**
 * Put the settings popup of `state` on a mount of any chat host: `/effort` typed and routed by the host; the two test popups opened on the
 * host's popup host directly, as the test layer's report popup is.
 */
export async function driveSettings(
  m: {
    readonly settle: () => Promise<void>;
    readonly until: (predicate: () => boolean) => Promise<boolean>;
    readonly frame: () => string[];
    readonly popups: { readonly openForUser: (spec: PopupSpec) => unknown };
    readonly key: (bytes: string) => void;
    readonly skip: (ms: number) => void;
  },
  type: (line: string) => Promise<void>,
  state: SettingsState,
  origin: PopupOrigin,
): Promise<void> {
  if (state === 'mode' || state === 'mode-apply') {
    await driveMode(m, type, state);
    return;
  }
  if (state === 'effort') await type('/effort');
  else m.popups.openForUser(state === 'form' ? testFormPopup(origin) : testEffectPopup(origin));
  await m.until(() => m.frame().join('\n').includes(SETTINGS_LANDMARKS[state]));
  await m.settle();
}

/**
 * `/mode` typed and routed by the host: its first step on the mode in force (`ask`), or its second for `auto` (three `↓`, then `Enter` once
 * the popup has settled), the step that states the effect it applies under.
 */
async function driveMode(
  m: Parameters<typeof driveSettings>[0],
  type: (line: string) => Promise<void>,
  state: 'mode' | 'mode-apply',
): Promise<void> {
  const shows = (text: string) => (): boolean => m.frame().join('\n').includes(text);
  await type('/mode');
  await m.until(shows(SETTINGS_LANDMARKS.mode));
  await m.settle();
  if (state === 'mode') return;
  m.skip(600);
  // One key per read: keys written together reach the renderer as one read, which is one key.
  for (let press = 0; press < 3; press += 1) {
    m.key(KEYS.down);
    await m.settle();
  }
  await m.until(shows(MODE_EFFECT.auto.full.slice(0, 40)));
  m.key(KEYS.enter);
  await m.until(shows(SETTINGS_LANDMARKS['mode-apply']));
  await m.settle();
}
