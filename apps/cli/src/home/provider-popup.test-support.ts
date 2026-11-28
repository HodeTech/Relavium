/**
 * Driving the Home's `/providers` popup (MVP-11 unit 6) through a mocked renderer, as the real host does it: every popup frame of the native
 * channel is acknowledged (`ui.shown`) as the live host's measured-frame acknowledgement would, and an answer waits out the popup's opening
 * settle (ADR-0148 §3: nothing answers for half a second after the flow's first frame) or, on the guarded consent row, the approval card's
 * layers (the lockout from the select's opening, the dwell from its frame). Every wait is a named constant, and an answer is pressed ONCE
 * after its wait (an early `Enter` on a guarded row restarts the lockout).
 */
import { expect, vi } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';

export type PromptUi = NonNullable<RootAppProps['nativePrompt']>;

/** Past the popup's opening settle, with room for a loaded machine. */
export const POPUP_ANSWER_WAIT_MS = POPUP_SELECT_SETTLE_MS + 150;
/** Past a guarded row's lockout (which runs from the select's opening) and its dwell, with room for a loaded machine. */
export const GUARDED_ANSWER_WAIT_MS = APPROVAL_LOCKOUT_MS + 400;
/** How long a step of a Home test may take to arrive on a loaded gate run. */
export const STEP_WAIT_MS = 5000;

export const KEY = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The renderer's part a mocked mount must play: acknowledge each new popup frame of the channel once it is published, as the live host does
 * after its flush (never inside the publication itself, where the prompt the frame belongs to is not open yet and its dwell could not start).
 */
export function acknowledgePopupFrames(ui: PromptUi): () => void {
  return ui.subscribe(() => {
    const snapshot = ui.getSnapshot();
    if (!snapshot.active || snapshot.popup === undefined) return;
    queueMicrotask(() => {
      if (ui.getSnapshot() === snapshot) ui.shown(snapshot);
    });
  });
}

/** Wait for an open select that offers `value`. */
export async function untilOption(ui: PromptUi, value: string): Promise<void> {
  await vi.waitFor(
    () => {
      const snapshot = ui.getSnapshot();
      expect(snapshot.kind).toBe('select');
      expect(snapshot.options.some((option) => option.value === value)).toBe(true);
    },
    { timeout: STEP_WAIT_MS },
  );
}

/**
 * Move the highlight to `value` with the arrows. A popup's arrows stop at the ends (ADR-0148 §3), so the direction is the shorter straight
 * way, never a wrap.
 */
export function highlight(ui: PromptUi, value: string): void {
  const snapshot = ui.getSnapshot();
  const target = snapshot.options.findIndex((option) => option.value === value);
  if (target < 0) throw new Error(`no row ${value}`);
  const up = target < snapshot.selected;
  for (let step = 0; step < Math.abs(target - snapshot.selected); step += 1)
    ui.input('', { ...KEY, upArrow: up, downArrow: !up });
}

/** Choose `value` on the open select of a popup: wait for it, highlight it, wait out the opening settle (or a guarded row's layers), `Enter`. */
export async function choose(ui: PromptUi, value: string): Promise<void> {
  await untilOption(ui, value);
  highlight(ui, value);
  const snapshot = ui.getSnapshot();
  const guarded = snapshot.options[snapshot.selected]?.guarded === true;
  await sleep(guarded ? GUARDED_ANSWER_WAIT_MS : POPUP_ANSWER_WAIT_MS);
  ui.input('\r', { ...KEY, return: true });
}

/** Paste `secret` into the open key step and submit it once the popup's opening settle has passed. */
export async function pasteKey(ui: PromptUi, secret: string): Promise<void> {
  await vi.waitFor(() => expect(ui.getSnapshot().kind).toBe('password'), {
    timeout: STEP_WAIT_MS,
  });
  ui.paste(secret);
  await sleep(POPUP_ANSWER_WAIT_MS);
  ui.input('\r', { ...KEY, return: true });
}

/** Close the persistent Done step with `Enter` (after the settle) or `Esc` (at once). */
export async function closeDone(ui: PromptUi, how: 'enter' | 'esc' = 'enter'): Promise<void> {
  await vi.waitFor(() => expect(ui.getSnapshot().final).toBeDefined(), { timeout: STEP_WAIT_MS });
  if (how === 'esc') {
    ui.input('', { ...KEY, escape: true });
    return;
  }
  await sleep(POPUP_ANSWER_WAIT_MS);
  ui.input('\r', { ...KEY, return: true });
}
