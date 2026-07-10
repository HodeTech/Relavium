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
 * The phase default when neither the flag nor the config key decides. `true` since 2.6.F Step 4b-3 (ADR-0068 §b): the
 * hand-built viewport (Step 4b-1), the scroll / auto-follow keymap (Step 4b-2), the caps-lift wrap cache (Step 4b-3),
 * and the inter-session alt-buffer HOIST (Step 4b-3 — no per-swap flicker) make the full-screen renderer first-class,
 * so a bare `relavium` / `relavium chat` on a TTY opens full-screen by default. `--no-alt-screen` (per invocation) or
 * `[preferences].alt_screen = false` (durable) opt back into the inline renderer (native scrollback + the emulator's
 * own a11y — the screen-reader fallback), and a machine / non-TTY / `--json` / CI path is ALWAYS inline regardless.
 */
export const DEFAULT_ALT_SCREEN = true;

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

/**
 * The phase default for terminal MOUSE reporting inside the full-screen renderer (2.6.F Step 5e, ADR-0068 §e).
 *
 * `true` — a maintainer decision that DEVIATES from ADR-0068 §e's "the first release defaults OFF (opt-in)". The
 * wheel is what most users expect of a full-screen TUI, and PgUp/PgDn alone surprised them. The ADR's reason for
 * defaulting off — mouse reporting disables the emulator's native click-drag SELECTION, worst over SSH/tmux — was
 * ANSWERED in Step 6: Relavium now runs its own selection and copy-on-select. The opt-out remains, for a user whose
 * terminal drops OSC 52 or who simply prefers the emulator's own selection: `--no-mouse` / `[preferences].mouse`,
 * plus the `/scrollback`, `/edit` and `/copy` hatches.
 */
export const DEFAULT_MOUSE = true;

/**
 * The phase default for COPY-ON-SELECT (2.6.F Step 6e). `true`, matching every competing agent CLI: a released drag
 * puts the selection on the system clipboard. Nothing about it is silent-but-harmful — the highlight shows exactly
 * what will be copied — but it does overwrite whatever the user last copied elsewhere, so the opt-out exists.
 */
export const DEFAULT_COPY_ON_SELECT = true;

export interface MouseModeInput {
  /** The already-resolved render mode. Mouse reporting exists ONLY in the alt screen — the inline renderer must never
   *  enable it (it would break the native scrollback capture the inline mode is chosen for). Taking the RESOLVED mode
   *  (not the raw signals) makes that structural: an `inline` caller cannot accidentally ask for the mouse. */
  readonly renderMode: RenderMode;
  /** `true` when `--no-mouse` was passed — the per-invocation opt-out, overriding the config key. */
  readonly noMouseFlag: boolean;
  /** `[preferences].mouse`: `true` opts in, `false` opts out, `undefined` falls to {@link defaultMouse}. */
  readonly configMouse: boolean | undefined;
  /** The phase default when neither flag nor config decides; {@link DEFAULT_MOUSE} when omitted. */
  readonly defaultMouse?: boolean;
}

/**
 * Resolve whether to enable mouse reporting (DECSET 1002 + 1006). Precedence mirrors {@link resolveRenderMode}:
 * inline short-circuits FIRST → `--no-mouse` flag → config key → phase default.
 */
export function resolveMouseMode(input: MouseModeInput): boolean {
  if (input.renderMode === 'inline') return false; // never in the inline renderer, whatever the flag or key says
  if (input.noMouseFlag) return false; // the explicit flag opt-out overrides the config key
  return input.configMouse ?? input.defaultMouse ?? DEFAULT_MOUSE;
}

export interface CopyOnSelectInput {
  /** The already-RESOLVED mouse decision. Copy-on-select is a property of a selection, and there are no selections
   *  without mouse reporting — so an unmoused caller cannot accidentally ask for it. Same structural trick as
   *  {@link MouseModeInput.renderMode}. */
  readonly mouseEnabled: boolean;
  /** `[preferences].copy_on_select`: `true` opts in, `false` opts out, `undefined` falls to {@link defaultCopyOnSelect}. */
  readonly configCopyOnSelect: boolean | undefined;
  /** The phase default when the config does not decide; {@link DEFAULT_COPY_ON_SELECT} when omitted. */
  readonly defaultCopyOnSelect?: boolean;
}

/**
 * Resolve whether a released drag writes to the system clipboard. There is deliberately NO flag: it is a durable
 * preference, not a per-invocation one, and `--no-mouse` already turns off the gesture that produces it.
 *
 * NOT auto-disabled inside tmux/zellij, though the first design said it should be. tmux honours an application's
 * OSC 52 only under `set-clipboard on` or `allow-passthrough on` (read from its source; see `clipboard.ts`), so a copy
 * there may silently do nothing — but that is indistinguishable from VS Code Remote SSH dropping the escape, which we
 * already accept and report honestly as `'written'` rather than `'copied'`. Guessing at a multiplexer's configuration
 * and silently disabling a feature is worse than attempting it.
 */
export function resolveCopyOnSelect(input: CopyOnSelectInput): boolean {
  if (!input.mouseEnabled) return false; // no mouse ⇒ no selection ⇒ nothing to copy
  return input.configCopyOnSelect ?? input.defaultCopyOnSelect ?? DEFAULT_COPY_ON_SELECT;
}
