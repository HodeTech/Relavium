/**
 * When the Home's strip does not refresh ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6): the tick reads the strip only while the landing is what the person is looking at and typing into. PURE: every condition is one
 * fact the controller hands in, so each can be pinned alone (`strip-pause.test.ts`).
 *
 * - Not the landing: a chat or the build before it (`mode`).
 * - A screen is in front: the run view, a gate card, the tab host, the help sheet.
 * - An overlay owns the keyboard: the palette, the model picker, and the chat's own effort overlay, permissions sheet, reverse search and
 *   `@`-mention (the last four open only in a chat, so in practice `mode` has paused the strip already; the facts are still read, so a
 *   path that ever opens one at the landing pauses it too).
 * - A card owns the keyboard: the exit question, or a native form (provider setup, the launch flow, a session resume).
 * - The terminal is below 80×24: the strip shows one line and nothing in it can be acted on.
 *
 * What is not here, on purpose: a draft in the prompt (the strip may repaint under it, and the focus is an identity), the Home ending
 * (the controller cancels the poll in the same step that ends it, so no tick can see it) and a submit in flight (it is only ever set in a
 * chat, which `mode` covers).
 */

import { homeFitsTerminal } from './home-projection.js';
import { stripPausedByOverlay, type OverlayFlags } from './overlay-flags.js';

/**
 * Every fact is one flag of {@link OverlayFlags} (the screen, the six submodes, the exit question and the native action; which of the
 * record's flags pause the strip is the record's table, `overlay-flags.ts`), plus the mode and the terminal. The WHOLE record is required: a
 * flag added to it is a compile error at every caller instead of a flag that reads as `false` here (round 2, M2).
 */
export interface StripPauseFacts extends OverlayFlags {
  readonly mode: 'home' | 'loading' | 'chat';
  /** The terminal as the host last told the Home, or `undefined` before it did (assumed big enough). */
  readonly terminal: { readonly columns: number; readonly rows: number } | undefined;
}

/** Whether the idle tick reads nothing now. */
export function stripRefreshPaused(facts: StripPauseFacts): boolean {
  return (
    facts.mode !== 'home' ||
    stripPausedByOverlay(facts) ||
    (facts.terminal !== undefined && !homeFitsTerminal(facts.terminal.columns, facts.terminal.rows))
  );
}
