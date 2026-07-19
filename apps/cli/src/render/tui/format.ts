import type { NodeStatus } from './run-view-model.js';

/**
 * Pure presentational helpers for the `ink` TUI (workstream **2.E**) — color-agnostic: they return plain
 * strings and a *semantic* color name, and the React/`ink` component decides whether to apply it (honoring
 * `--no-color`). Kept here so the formatting (cost, duration, glyphs) is unit-tested without a TTY or React.
 */

/** Semantic color names the component maps to `ink`'s `<Text color>` (or omits under `--no-color`). */
export type StatusColor = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta';

/** Braille spinner frames for a running node (cycled by the renderer's frame loop). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** The spinner glyph for a given monotonic frame tick. */
export function spinnerFrame(tick: number): string {
  const len = SPINNER_FRAMES.length;
  // Guard against a negative/NaN tick — fall back to the first frame.
  const index = Number.isFinite(tick) ? ((Math.trunc(tick) % len) + len) % len : 0;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/** The static glyph for a non-running status (the running status uses {@link spinnerFrame}). */
export function statusGlyph(status: NodeStatus): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'running':
      return '◐';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'skipped':
      return '⊘';
    case 'retrying':
      return '↻';
  }
}

/** The semantic color for a status (the component applies it only when color is enabled). */
export function statusColor(status: NodeStatus): StatusColor {
  switch (status) {
    case 'pending':
      return 'gray';
    case 'running':
      return 'cyan';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'skipped':
      return 'gray';
    case 'retrying':
      return 'yellow';
  }
}

/**
 * Format an integer micro-cents amount as a USD string. The canonical unit is integer **micro-cents** —
 * 1e-8 USD (USD × 100,000,000), per [database-schema.md](../../../../../docs/reference/shared-core/database-schema.md)
 * / [llm-provider-seam.md](../../../../../docs/reference/shared-core/llm-provider-seam.md#6-usage). Four
 * fractional digits give sub-cent visibility (e.g. 5,000,000 → `$0.0500`).
 */
export function formatCostUsd(microcents: number): string {
  const usd = microcents / 1e8;
  return `$${usd.toFixed(4)}`;
}

/**
 * The Home-strip cost label (2.5.B): "free" at zero/non-finite (the common zero-cost chat reads better than
 * `$0.0000`), else {@link formatCostUsd}. Reuses the canonical µ¢→USD conversion so there is exactly one home for
 * that math (CLAUDE.md rule 8) — never a second hand-rolled divisor that could drift by a factor of 100. NOTE: a
 * tiny nonzero cost below 5000 µ¢ (sub-$0.0001) rounds to `$0.0000`, not `free` — nonzero is not free.
 */
export function formatCostShort(microcents: number): string {
  // `<= 0 || !isFinite` ⇒ "free": guards a NaN (which `<= 0` alone would miss → "$NaN") to a safe label.
  return microcents > 0 && Number.isFinite(microcents) ? formatCostUsd(microcents) : 'free';
}

/** Format a millisecond duration compactly: `420ms`, `3.2s`, `1m04s`. Negatives (clock skew) clamp to 0. */
export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < 1000) {
    return `${Math.round(safeMs)}ms`;
  }
  const totalSeconds = safeMs / 1000;
  // Below the boundary where one-decimal rounding would read "60.0s" — show one-decimal seconds.
  if (totalSeconds < 59.95) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  // Round to whole seconds, then carry into minutes — so 59.95–59.999s → "1m00s" and 119.6s → "2m00s",
  // never the invalid "60.0s" or "1m60s". The whole-second modulo subsumes the old carry special-case.
  const wholeSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Format an elapsed millisecond count for a LIVE in-flight counter (the "thinking…/working… {elapsed}" turn
 * timer, 2.5.H): WHOLE seconds only so it does not jitter every ~80ms animation frame — `3s`, `12s`, `1m03s`.
 * Negatives (clock skew) clamp to 0. Distinct from {@link formatDuration}, which shows sub-second precision for a
 * COMPLETED span (a live counter reading "3.2s" then "3.3s" every frame is noise, not precision).
 */
export function formatElapsed(ms: number): string {
  // Guard a non-finite input to 0 (symmetry with `spinnerFrame`) so a NaN can never render "NaNmNaNs".
  const totalSeconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Format a token-usage pair as `↑in ↓out`. */
export function formatTokens(tokens: { readonly input: number; readonly output: number }): string {
  return `↑${tokens.input} ↓${tokens.output}`;
}

/**
 * Format a produced media deliverable as a one-line, secret-free reference: `◆ image/png media://sha256-…`.
 * Renders the durable HANDLE (never inline bytes) — the CLI's leaf of the cross-surface "each surface renders a
 * produced media handle" acceptance (2.S/D-series, ADR-0042). Takes the structural minimum so both the TUI's `ProducedMediaView` and
 * the engine's `DurableMediaMeta` (the plain renderer's source) reuse one format. Node attribution is the caller's.
 * The leading `◆` is a monochrome glyph, consistent with the render layer's other glyphs (no pictographic emoji).
 */
export function formatProducedMedia(media: {
  readonly mimeType: string;
  readonly handle: string;
}): string {
  return `◆ ${media.mimeType} ${media.handle}`;
}
