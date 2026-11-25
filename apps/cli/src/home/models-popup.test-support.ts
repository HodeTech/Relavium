/**
 * Test support for the Home's `/models` popup in the tests that drive `driveHome` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §3; MVP-11 step 5): `/models` typed into the Home, the popup answered the way a person answers it (the filter typed, `Enter` on the
 * model it leaves, `Enter` on the form), its keys given to the Home's popup host as the Home's input owner gives them.
 *
 * Two kinds of test use it. Where the Home's render is injected (no Home root is mounted), nothing measures a frame of the popup host as the
 * popup slot does, so the test is the slot: it says each frame is on screen. Where a real Home root is mounted (`live`), its slot does that,
 * and nothing is bound over it. Either way a key the host drops (a frame not yet acknowledged, the opening guard's settle, the form's own
 * settle) is pressed again, and never once it has moved the popup.
 */
import { expect, vi } from 'vitest';

import type { PopupHost } from '../popups/popup-host.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';

/** The opening guard's settle (500 ms) and a margin: before it, an answer is dropped (real time: the host's clock is `performance.now`). */
const SETTLE_MS = 600;
/**
 * A form's `Enter` waits out the approval's lockout after the answer that reached it (`popup-host.ts`: a held key's first repeat never
 * applies a form) and a margin: before it, the `Enter` is dropped. It also covers the form's own settle.
 */
const FORM_READY_MS = APPROVAL_LOCKOUT_MS + 200;

export interface ModelsPopupOptions {
  /** A real Home root is mounted: its popup slot acknowledges the frames, and the test binds nothing over it. */
  readonly live?: boolean;
  readonly waitMs?: number;
}

/**
 * `/models` typed into the Home (its landing, or the chat in front), the popup open on the Home's host and its settle passed. The popup's
 * code is loaded on first use, so it appears a moment after the line.
 */
export async function openModelsPopup(
  props: RootAppProps,
  options: ModelsPopupOptions = {},
): Promise<PopupHost> {
  const popups = props.popups;
  if (popups === undefined) throw new Error('the Home was rendered without a popup host');
  props.controller.handlePaste('/models');
  props.controller.handleKey('', { return: true });
  await vi.waitFor(() => expect(popups.getSnapshot().frame?.spec.id).toBe('models'), {
    timeout: options.waitMs ?? 5000,
  });
  if (options.live !== true) {
    popups.bindVisibility(() => true);
    popups.bindPageRows(() => 17);
    popups.bindInnerWidth(() => 66);
    popups.shown(popups.getSnapshot());
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
  return popups;
}

/**
 * The popup's form (step 2) is a frame of its own: acknowledged as the slot acknowledges it (by the test, where no Home root is mounted), and
 * its own settle waited out, so the `Enter` pressed next applies it (`popup-host.ts`, "A form settles on its own frame").
 */
export async function settleModelsForm(
  popups: PopupHost,
  options: ModelsPopupOptions = {},
): Promise<void> {
  if (options.live !== true) popups.shown(popups.getSnapshot());
  await new Promise<void>((resolve) => {
    setTimeout(resolve, FORM_READY_MS);
  });
}

/**
 * Press `key` on the popup until `moved` holds (a key the host dropped is pressed again; none after it moved), every `interval` ms. A form's
 * `Enter` is pressed again only a quiet gap apart (`QUIET_PRESS_MS`): a press inside the quiet gap of the key before it is a held key's repeat,
 * which never applies a form (`popup-host.ts`, "A held key never applies a form").
 */
async function pressUntil(
  popups: PopupHost,
  key: Parameters<PopupHost['input']>[1],
  moved: () => boolean,
  waitMs: number,
  interval = 50,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!moved()) popups.input('', key);
      expect(moved()).toBe(true);
    },
    { timeout: waitMs, interval },
  );
}

/** How far apart a form's `Enter` is pressed again: more than the approval's quiet gap (300 ms). */
const QUIET_PRESS_MS = 350;

/**
 * `/models` answered: `filter` typed into the list, `Enter` on the first model it leaves (the second step opens on its form), and `Enter` on the
 * form: `This chat` in a chat (or `New chats`, when asked), the default of new chats on the bare Home. The popup is closed when this returns.
 */
export async function answerModelsPopup(
  props: RootAppProps,
  filter: string,
  options: ModelsPopupOptions & { readonly newChats?: boolean } = {},
): Promise<PopupHost> {
  const waitMs = options.waitMs ?? 5000;
  const popups = await openModelsPopup(props, options);
  // One character at a time: each one is a new frame, which a mounted slot acknowledges before the next key counts (a key on a frame
  // nobody has seen is dropped, never queued, so it is pressed again).
  const typed = (): string | undefined => popups.getSnapshot().frame?.steps[0]?.filter;
  for (let at = 1; at <= filter.length; at += 1) {
    const want = filter.slice(0, at);
    await vi.waitFor(
      () => {
        if (typed() !== want) popups.input(filter.charAt(at - 1), {});
        expect(typed()).toBe(want);
      },
      { timeout: waitMs, interval: 20 },
    );
  }
  const step = (): number | undefined => popups.getSnapshot().frame?.stepIndex;
  await pressUntil(popups, { return: true }, () => step() === 1, waitMs);
  if (options.newChats === true) popups.input('', { downArrow: true });
  // The form is a frame of its own, which the slot (or the test, where none is mounted) acknowledges; its `Enter` counts only once that frame
  // has settled and a quiet gap after the key before it (`popup-host.ts`): both are waited out before its first press, and a press the host
  // still drops is repeated a quiet gap later, never sooner.
  await settleModelsForm(popups, options);
  await pressUntil(
    popups,
    { return: true },
    () => !popups.getSnapshot().open,
    waitMs,
    QUIET_PRESS_MS,
  );
  return popups;
}
