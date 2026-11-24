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

/**
 * How long the Home waits for a hosted run to settle after the person confirmed leaving it
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6): the engine's own grace window for a
 * cooperative cancel. Past it the Home abandons the leg as the engine does, runs its teardown and exits, so no path leaves the Home
 * waiting without a bound.
 */
export const HOSTED_RUN_EXIT_GRACE_MS = 10_000;

/**
 * How much longer the run host's own `close` waits for a stopped leg once the grace ran out ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §6). It is the host's bound (`HOSTED_LEG_SETTLE_BOUND_MS` is this value), kept here so the exit-guard card can name the whole wait
 * without importing the host.
 */
export const HOSTED_RUN_EXIT_SETTLE_MS = 3_000;

/** The longest a confirmed exit waits for a leg: the grace and then the host's settle bound. Past it the finite-exit bound ends the process. */
export const HOSTED_RUN_EXIT_BOUND_MS = HOSTED_RUN_EXIT_GRACE_MS + HOSTED_RUN_EXIT_SETTLE_MS;

/** How often the Home re-reads its run host while a leg is live (the strip's run row, and the wait of a confirmed exit). */
export const HOSTED_RUN_POLL_MS = 250;
