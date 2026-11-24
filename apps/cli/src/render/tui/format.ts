import { isUsageCoverageComplete, type UsageCoverage } from '@relavium/shared';
import { formatUsd } from '../notation.js';
import { glyph, toneOf, type GlyphTone, type StatusGlyphRole } from './glyphs.js';
import type { NodeStatus } from './run-view-model.js';

/**
 * Pure presentational helpers for the `ink` TUI (workstream **2.E**) — color-agnostic: they return plain
 * strings and a *semantic* color name, and the React/`ink` component decides whether to apply it (honoring
 * `--no-color`). Kept here so the formatting (cost, duration, glyphs) is unit-tested without a TTY or React.
 */

/** Semantic color names the component maps to `ink`'s `<Text color>` (or omits under `--no-color`): the glyph table's own list. */
export type StatusColor = GlyphTone;

/** Braille spinner frames for a running node (cycled by the renderer's frame loop). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** The spinner glyph for a given monotonic frame tick. */
export function spinnerFrame(tick: number): string {
  const len = SPINNER_FRAMES.length;
  // Guard against a negative/NaN tick — fall back to the first frame.
  const index = Number.isFinite(tick) ? ((Math.trunc(tick) % len) + len) % len : 0;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/** The glyph-table role of each node status: the table owns the glyph, its plain form, its word and its colour. */
export const NODE_STATUS_ROLE: Readonly<Record<NodeStatus, StatusGlyphRole>> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  retrying: 'retrying',
};

/** The static glyph for a non-running status (the running status uses {@link spinnerFrame}), in the form in force ({@link glyph}). */
export function statusGlyph(status: NodeStatus): string {
  return glyph(NODE_STATUS_ROLE[status]);
}

/** The semantic color for a status (the component applies it only when color is enabled). */
export function statusColor(status: NodeStatus): StatusColor {
  return toneOf(NODE_STATUS_ROLE[status]);
}

/**
 * A known sum qualified by accounting coverage; unknown usage is never a free call. The amount is the one USD notation of
 * [notation.ts](../notation.ts) (`$0.0500`: integer micro-cents, four fractional digits); an amount it cannot show is `unavailable`.
 */
export function formatReportedCost(
  microcents: number,
  coverage: UsageCoverage | undefined,
  unpricedCalls = 0,
): string {
  const amount = formatUsd(microcents);
  const notes: string[] = [];
  if (coverage === undefined || coverage.unverified) notes.push('usage unverified');
  if (coverage !== undefined && coverage.pendingInvocations > 0)
    notes.push(`${coverage.pendingInvocations} usage pending`);
  if (coverage !== undefined && coverage.unknownCalls > 0)
    notes.push(
      `usage unknown for ${coverage.unknownCalls} ${coverage.unknownCalls === 1 ? 'call' : 'calls'}`,
    );
  if (unpricedCalls > 0)
    notes.push(`price unknown for ${unpricedCalls} ${unpricedCalls === 1 ? 'call' : 'calls'}`);
  return notes.length === 0 ? amount : `${amount} known; ${notes.join('; ')}`;
}

/** Compact Home cost. Only verified, fully priced zero is free. */
export function formatCostShort(
  microcents: number,
  coverage: UsageCoverage | undefined,
  unpricedCalls = 0,
): string {
  return microcents === 0 &&
    coverage !== undefined &&
    isUsageCoverageComplete(coverage) &&
    unpricedCalls === 0
    ? 'free'
    : formatReportedCost(microcents, coverage, unpricedCalls);
}

/** Format a token-usage pair as `↑in ↓out`. */
export function formatTokens(tokens: { readonly input: number; readonly output: number }): string {
  return `↑${tokens.input} ↓${tokens.output}`;
}

/**
 * Format a produced media deliverable as a one-line, secret-free reference: `◆ image/png media://sha256-…` (the glyph table's `media`).
 * Renders the durable HANDLE (never inline bytes) — the CLI's leaf of the cross-surface "each surface renders a
 * produced media handle" acceptance (2.S/D-series, ADR-0042). Takes the structural minimum so both the TUI's `ProducedMediaView` and
 * the engine's `DurableMediaMeta` (the plain renderer's source) reuse one format. Node attribution is the caller's.
 * The leading `◆` is a monochrome glyph, consistent with the render layer's other glyphs (no pictographic emoji).
 */
export function formatProducedMedia(media: {
  readonly mimeType: string;
  readonly handle: string;
}): string {
  return `${glyph('media')} ${media.mimeType} ${media.handle}`;
}
