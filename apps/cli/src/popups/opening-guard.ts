/**
 * The opening guard of a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3):
 * what keeps a popup from being answered by what was typed before it appeared. It applies to every popup, the ones the person opens and (unit 6)
 * the first-run setup that opens itself, because a popup appears under the person's fingers either way: a `/mode` typed and a reflex `Enter` chain
 * land in the same stdin read as the popup's own opening.
 *
 * Three rules, each judged on ONE monotonic clock against the moment the key ARRIVED (the host stamps it before it is routed):
 *
 * 1. **A key that arrived before the popup's first measured and flushed frame is dropped**, and the host has already counted it as typing (the
 *    key history every guard of the host reads). Nothing can be chosen on a frame nobody has seen.
 * 2. **Nothing selects for {@link POPUP_SELECT_SETTLE_MS} after the popup appeared**: an `Enter` (or a control that acts) needs that much time
 *    on screen, as the approval card's dwell does; the arrows move at once, because moving the highlight decides nothing.
 * 3. **An answer needs a key that arrived after the popup appeared**, so a key that was already on its way (a held key's repeat queued in the
 *    same read) is not an answer even if it is processed later.
 *
 * The keys that leave (`Esc`, `Ctrl+C`) are always admitted: leaving answers nothing, and a popup must never trap the person.
 *
 * Pure and framework-free; the clock is injected (`popup-opening-guard.test.ts` drives it), production passes `performance.now`.
 */

/** How long a popup has been on screen before an `Enter` (or a control that acts) counts. About half a second (§3). */
export const POPUP_SELECT_SETTLE_MS = 500;

/**
 * What a key would do, as far as the guard is concerned: leave the popup (`Esc`, `Ctrl+C`), move the highlight or scroll (`navigate`), answer
 * a step (`Enter`, a control letter), or type into a text field (`type`).
 */
export type OpeningKey = 'leave' | 'navigate' | 'answer' | 'type';

export interface OpeningGuard {
  /** The popup's first frame was measured and flushed. Only the first call counts: a popup appears once. */
  readonly shown: () => void;
  /** When the popup first appeared on screen, or `undefined` while it has not. */
  readonly shownAt: () => number | undefined;
  /** Whether a key of this kind, which arrived at `arrivedAt` on the guard's clock, may act. */
  readonly admits: (kind: OpeningKey, arrivedAt: number) => boolean;
}

export function createOpeningGuard(options: {
  /** A MONOTONIC millisecond clock (production: `performance.now`). */
  readonly now: () => number;
  /** The settle time (default {@link POPUP_SELECT_SETTLE_MS}); `0` switches rule 2 off for a test that isolates another rule. */
  readonly settleMs?: number | undefined;
}): OpeningGuard {
  const settleMs = options.settleMs ?? POPUP_SELECT_SETTLE_MS;
  let appearedAt: number | undefined;
  return {
    shown: () => {
      appearedAt ??= options.now();
    },
    shownAt: () => appearedAt,
    admits: (kind, arrivedAt) => {
      if (kind === 'leave') return true;
      // Rules 1 and 3: on a frame nobody has seen, or a key already on its way when it appeared, nothing acts.
      if (appearedAt === undefined || arrivedAt <= appearedAt) return false;
      // Rule 2: the arrows and a text field act at once; an answer waits out the settle.
      return kind !== 'answer' || arrivedAt - appearedAt >= settleMs;
    },
  };
}
