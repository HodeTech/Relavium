/**
 * The Home's terminal floor (ADR-0054 / §2.5.B): the smallest terminal it renders in, and the one line it shows below it. A leaf: it imports
 * nothing, so the run cards (`run-card-model.ts`, which the full text scrub `flow-text.ts` reads its author-text floor from) and the strip's
 * labels (`home-projection.ts`, which scrubs with `flow-text.ts`) can both read it without a cycle between them. `home-projection.ts`
 * re-exports it, where its callers have always found it.
 */

/** The minimum terminal the Home renders in; below it, degrade to a resize prompt (ADR-0054 / §2.5.B). */
export const HOME_MIN_COLS = 80;
export const HOME_MIN_ROWS = 24;

/** Whether the terminal is at least the Home minimum — else the caller renders {@link tooSmallMessage}. */
export function homeFitsTerminal(cols: number, rows: number): boolean {
  return (
    Number.isSafeInteger(cols) &&
    Number.isSafeInteger(rows) &&
    cols >= HOME_MIN_COLS &&
    rows >= HOME_MIN_ROWS
  );
}

/** The single-line degrade shown (and held until a resize) when the terminal is below the Home minimum. */
export function tooSmallMessage(cols: number, rows: number): string {
  return `Terminal too small (${cols}×${rows}) — resize to at least ${HOME_MIN_COLS}×${HOME_MIN_ROWS}.`;
}
