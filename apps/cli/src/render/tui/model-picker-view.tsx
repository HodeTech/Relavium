import { Box, Text } from 'ink';
import type { ReactElement, ReactNode } from 'react';

import { sanitizeInline } from './chat-projection.js';
import {
  formatContextWindow,
  formatModelPrice,
  formatRefreshedBadge,
  visibleModels,
  type ModelPickerState,
} from './model-picker.js';
import { colorProps, dimProps } from './projection.js';

/** The most model rows shown at once — a large multi-provider catalog scrolls a window around the selection rather
 *  than flooding the terminal (parity with the mention overlay's {@link MENTION_WINDOW}). */
const MODEL_WINDOW = 8;

/**
 * The `/models` picker overlay (2.5.G S7, [ADR-0064](../../../../../docs/decisions/0064-live-model-catalog.md) §10)
 * — a PURE ink view over the merged, filtered catalog. It owns NO `useInput`: the Home's `RootApp` (the single
 * raw-mode owner) routes keys to `foldModelPickerKey` and re-renders this from the resulting {@link ModelPickerState}.
 * Every free-form field (each display name, the filter echo, the freshness/partial-failure banners) is sanitized at
 * this display boundary, so a provider-controlled model name (or a crafted refresh error) can neither forge a row
 * nor inject a terminal escape. Renders the first-class UX the ADR mandates: pricing, a dimmed "unavailable on your
 * key" row, a `deprecated` flag, an unpriced "cost cap will not apply" hint, a loading spinner, a per-provider
 * partial-failure banner, and a "last updated" freshness badge.
 */
export interface ModelPickerViewProps {
  readonly state: ModelPickerState;
  readonly color: boolean;
  /** The injected clock (epoch-ms) for the freshness badge — threaded from `RootApp` so the relative age is testable. */
  readonly nowMs: number;
}

/** The window of row indices to render around `selected` (a `[start, end)` slice), keeping the selection visible and
 *  never exceeding {@link MODEL_WINDOW} rows. Pure so the scroll math is unit-checkable. */
export function modelWindow(count: number, selected: number): { start: number; end: number } {
  if (count <= MODEL_WINDOW) return { start: 0, end: count };
  const half = Math.floor(MODEL_WINDOW / 2);
  const start = Math.max(0, Math.min(selected - half, count - MODEL_WINDOW));
  return { start, end: start + MODEL_WINDOW };
}

export function ModelPickerView(props: Readonly<ModelPickerViewProps>): ReactElement {
  const { state, color, nowMs } = props;
  const visible = visibleModels(state);
  // Clamp the highlight for display — a refresh can shrink the list under a `selected` past the new end until the
  // next keystroke re-clamps (foldModelPickerKey clamps on move).
  const selected = visible.length === 0 ? 0 : Math.max(0, Math.min(state.selected, visible.length - 1));
  const { start, end } = modelWindow(visible.length, selected);
  const windowed = visible.slice(start, end);
  const badge = `${formatRefreshedBadge(state.refreshedAt, nowMs)}${state.loading ? ' · refreshing…' : ''}`;
  // One status line: the transient user-action `hint` (a dimmed/save note) takes priority over the async refresh
  // `banner` (partial-failure) so a completing refresh can never silently wipe the feedback the user just triggered.
  const status = state.hint ?? state.banner;

  const renderBody = (): ReactNode => {
    if (state.loading && visible.length === 0) {
      return (
        <Text {...dimProps(color)} wrap="truncate-end">
          loading models…
        </Text>
      );
    }
    if (state.entries.length === 0) {
      return (
        <Text {...dimProps(color)} wrap="truncate-end">
          no models yet — add a provider key with `relavium provider add`, then Ctrl+R to refresh
        </Text>
      );
    }
    if (visible.length === 0) {
      return (
        <Text {...dimProps(color)} wrap="truncate-end">
          no model matches
        </Text>
      );
    }
    return windowed.map((entry, index) => {
      const isSelected = start + index === selected;
      const isDefault = entry.modelId === state.currentDefault;
      const ctx = formatContextWindow(entry.contextWindowTokens);
      const parts = [
        sanitizeInline(entry.displayName),
        entry.provider,
        ...(ctx.length > 0 ? [ctx] : []),
        formatModelPrice(entry),
        ...(entry.available ? [] : ['unavailable on your key']),
        ...(entry.deprecated ? ['deprecated'] : []),
      ];
      // Selected → cyan (highlight wins for visibility); else an unavailable/deprecated row is dimmed; else default.
      const rowColor = isSelected
        ? colorProps(color, 'cyan')
        : !entry.available || entry.deprecated
          ? dimProps(color)
          : {};
      return (
        <Text key={`${entry.provider}:${entry.modelId}`} {...rowColor} wrap="truncate-end">
          {`${isSelected ? '›' : ' '} ${isDefault ? '✓' : ' '} ${parts.join(' · ')}`}
        </Text>
      );
    });
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
        Set your default model
        <Text {...dimProps(color)}>{` · ${badge}`}</Text>
      </Text>
      {status !== undefined && (
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {sanitizeInline(status)}
        </Text>
      )}
      <Text {...dimProps(color)} wrap="truncate-end">
        {'model: '}
        <Text bold>{sanitizeInline(state.filter)}</Text>
      </Text>
      {renderBody()}
      <Text {...dimProps(color)} wrap="truncate-end">
        ↑/↓ select · Enter set default · Ctrl+R refresh · Esc cancel
      </Text>
    </Box>
  );
}
