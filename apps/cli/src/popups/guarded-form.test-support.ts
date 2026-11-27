/**
 * Test support for the popup host's form guards ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3; MVP-11 step 5; `popup-host.ts`, "A form settles on its own frame"): a two-step popup whose second step is a FORM that is guarded when
 * what it applies widens authority, the shape `/mode` had until MVP-11 unit 8 (OD-25 replaced its second screen with `Enter` and `[s]` on one
 * list). The host's form guards are still the ones `/models` uses (its second step is guarded when the provider changes), and
 * `popup-form-settle.test.ts` and `popup-form-settle-gaps.test.ts` keep pinning them through this fixture, so the pin does not depend on a
 * product command that no longer has such a step. Nothing here is a product popup: the title is the test's own.
 */

import type { ChatMode } from '@relavium/shared';

import { announcesEffect, MODE_EFFECT } from '../chat/mode-effects.js';
import type { PopupForm } from './frame-model.js';
import type { PopupHost, PopupOpenResult } from './popup-host.js';
import type { PopupSpec } from './popup-reducer.js';
import { modeContent, modeOfRow } from './mode-popup.js';

/** The step of the form. */
export const SCOPE_STEP = 1;

/** The two places the form applies the mode to. */
export type GuardedScope = 'this-chat' | 'new-chats';

/** What the fixture reads and does: the mode in force, the setter of this chat, and the hand-off for new chats. */
export interface GuardedModeMember {
  readonly current: () => ChatMode;
  readonly apply: (mode: ChatMode) => boolean;
  readonly saveStartupDefault: (mode: ChatMode) => Promise<unknown>;
}

/** The form for `mode`: where it applies, its effect stated where it approves without a card, GUARDED where it widens authority. */
export function guardedScopeForm(mode: ChatMode): PopupForm {
  return {
    kind: 'form',
    summary: `Mode: ${mode}`,
    radio: {
      label: 'Apply to',
      verb: 'apply to',
      initial: 'this-chat',
      options: [
        {
          id: 'this-chat',
          label: 'This chat',
          detail: 'switches the mode now; the conversation stays',
        },
        {
          id: 'new-chats',
          label: 'New chats',
          detail: 'saves it as your startup default; this chat stays',
        },
      ],
    },
    ...(announcesEffect(mode) ? { warning: MODE_EFFECT[mode].full, guarded: true as const } : {}),
  };
}

/** The fixture's spec: the list (the mode in force opened on), then the form. */
export function guardedModeSpec(current: ChatMode): PopupSpec {
  const list = modeContent({ surface: 'chat', current });
  return {
    id: 'guarded-mode',
    title: 'Guarded form',
    origin: 'chat',
    steps: [
      { name: 'Mode', content: list, enter: 'next', initialRow: current },
      {
        name: 'Apply to',
        content: guardedScopeForm(current),
        enter: 'apply',
        legendKeep: ['Enter'],
      },
    ],
  };
}

/** Open the fixture on `host`: step 1's `Enter` goes to the form for the chosen mode, the form's `Enter` applies it and closes. */
export function openGuardedMode(host: PopupHost, member: GuardedModeMember): PopupOpenResult {
  let chosen: ChatMode | undefined;
  return host.openForUser(guardedModeSpec(member.current()), {
    enter: (context, row) => {
      const picked = modeOfRow(row?.id);
      if (picked === undefined) return;
      chosen = picked;
      if (context.setContent(SCOPE_STEP, guardedScopeForm(picked))) context.goToStep(SCOPE_STEP);
    },
    apply: (context, values) => {
      const picked = chosen;
      if (picked === undefined) return;
      context.close();
      if (values.radio === 'new-chats') void member.saveStartupDefault(picked);
      else member.apply(picked);
    },
  });
}
