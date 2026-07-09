import type { OutputMode } from '../process/output-mode.js';

/**
 * Render-mode resolution for the interactive surfaces (the bare Home + `relavium chat`), 2.6.F / ADR-0068 §e.
 *
 * `alt` mounts the full-screen alternate-screen renderer; `inline` keeps the byte-identical inline renderer (native
 * scrollback + the emulator's own a11y) — the screen-reader fallback and the ONLY mode a machine / non-TTY path
 * ever uses, so the `--json` / CI / piped output stays byte-identical to today (a hard guarantee of the ADR).
 *
 * PURE: injected signals, no `process` read — the caller passes the already-detected {@link OutputMode}, the
 * `--no-alt-screen` flag, and the `[preferences].alt_screen` config value.
 */
export type RenderMode = 'alt' | 'inline';

/**
 * The phase default when neither the flag nor the config key decides. `false` at 2.6.F Step 4a — the alt screen is
 * OPT-IN (via `[preferences].alt_screen = true`) until the hand-built viewport lands (ADR-0068 §b), because
 * rendering the transcript through ink's `<Static>` into an alt buffer (which has no scrollback) is incomplete
 * until then. Step 4b flips this to `true` (alt-on with the `--no-alt-screen` opt-out) once the viewport makes the
 * full-screen renderer first-class.
 */
export const DEFAULT_ALT_SCREEN = false;

export interface RenderModeInput {
  /** The detected output mode. `'plain'` (a `--json` / CI / non-TTY path) is ALWAYS `inline`, byte-identical. */
  readonly outputMode: OutputMode;
  /** `true` when `--no-alt-screen` was passed — the per-invocation opt-out, overriding the config key. */
  readonly noAltScreenFlag: boolean;
  /** `[preferences].alt_screen`: `true` opts in, `false` opts out, `undefined` falls to {@link defaultAltScreen}. */
  readonly configAltScreen: boolean | undefined;
  /** The phase default when neither flag nor config decides; {@link DEFAULT_ALT_SCREEN} when omitted. */
  readonly defaultAltScreen?: boolean;
}

/**
 * Resolve the effective render mode. Precedence: machine/non-TTY gate → `--no-alt-screen` flag → config key → phase
 * default. A `'plain'` output mode short-circuits to `'inline'` FIRST, so the machine path can never be alt-screened
 * regardless of the flag/config.
 */
export function resolveRenderMode(input: RenderModeInput): RenderMode {
  if (input.outputMode === 'plain') return 'inline'; // machine / non-TTY — byte-identical to today (ADR-0068 §e)
  if (input.noAltScreenFlag) return 'inline'; // the explicit flag opt-out overrides the config key
  const enabled = input.configAltScreen ?? input.defaultAltScreen ?? DEFAULT_ALT_SCREEN;
  return enabled ? 'alt' : 'inline';
}
