/**
 * Shared TUI timing constants. Kept in a PURE module (no ink/React import) so the ink-free `HomeController` can
 * use them without coupling to a render surface — the single home for these two values, which were previously
 * duplicated across the ink renderer, the chat driver, the Home view, and `driveHome`.
 */

/** The frame cadence — ~12.5 fps: a smooth spinner + token flow without flooding React on a fast stream. */
export const FRAME_MS = 80;

/**
 * The bound (ms) a forced or return-to-Home teardown waits for a best-effort MCP graceful close before it stops
 * waiting — a hung stdio/network child must never freeze the process quit (the signal path) or the return to the
 * Home (the `endChat` path). The teardown still runs to completion in the background; only the UI/exit is bounded.
 */
export const FORCE_TEARDOWN_MS = 2000;

/** How long the "✓ Copied" toast lingers after a copy-on-select, before it auto-dismisses (2.6.F Step 6i). Long
 *  enough to register, short enough not to linger over the next selection. It renders OUTSIDE the transcript, so it
 *  never re-wraps the lines the user just selected — the reason success was silent until now. */
export const COPIED_TOAST_MS = 2000;
