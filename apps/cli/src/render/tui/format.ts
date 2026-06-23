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
 * 1e-8 USD (USD × 100,000,000), per [database-schema.md](../../../../../docs/reference/desktop/database-schema.md)
 * / [llm-provider-seam.md](../../../../../docs/reference/shared-core/llm-provider-seam.md#6-usage). Four
 * fractional digits give sub-cent visibility (e.g. 5,000,000 → `$0.0500`).
 */
export function formatCostUsd(microcents: number): string {
  const usd = microcents / 1e8;
  return `$${usd.toFixed(4)}`;
}

/** Format a millisecond duration compactly: `420ms`, `3.2s`, `1m04s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Format a token-usage pair as `↑in ↓out`. */
export function formatTokens(tokens: { readonly input: number; readonly output: number }): string {
  return `↑${tokens.input} ↓${tokens.output}`;
}
