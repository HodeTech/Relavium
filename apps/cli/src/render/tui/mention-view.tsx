import { Box, Text } from 'ink';
import type { ReactElement, ReactNode } from 'react';

import { sanitizeInline } from './chat-projection.js';
import { visibleMentions, type MentionState } from './mention.js';
import { colorProps, dimProps } from './projection.js';

/** The most candidate rows shown at once — a directory with hundreds of entries scrolls a window around the
 *  selection rather than flooding the terminal (the palette renders all; a directory listing can be far larger). */
const MENTION_WINDOW = 8;

/**
 * The `@`-mention completion overlay (2.5.D step 4, [ADR-0061](../../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))
 * — a PURE ink view over the filtered {@link visibleMentions}. It owns NO `useInput`: the single raw-mode owner
 * (the standalone `ChatApp` or the Home's `RootApp`) routes keys to `foldMentionKey` and re-renders this from the
 * resulting {@link MentionState}. Every free-form field — the browsed dir, the filter echo, each candidate name —
 * is sanitized at this display boundary, so a crafted filename (or a pasted control sequence) can neither forge a
 * row nor inject an escape. Directories carry a trailing `/`; the listing is already confidentiality-gated + noise-
 * filtered by the reader, so a `.ssh`/`.env` entry is never shown here.
 */
export interface MentionViewProps {
  readonly state: MentionState;
  readonly color: boolean;
}

/** The window of candidate indices to render around `selected` (a `[start, end)` slice), keeping the selection
 *  visible and never exceeding {@link MENTION_WINDOW} rows. Pure so the scroll math is unit-checkable. */
export function mentionWindow(count: number, selected: number): { start: number; end: number } {
  if (count <= MENTION_WINDOW) return { start: 0, end: count };
  const half = Math.floor(MENTION_WINDOW / 2);
  const start = Math.max(0, Math.min(selected - half, count - MENTION_WINDOW));
  return { start, end: start + MENTION_WINDOW };
}

export function MentionView(props: Readonly<MentionViewProps>): ReactElement {
  const { state, color } = props;
  const visible = visibleMentions(state);
  // Clamp the highlighted index for display — an async listing can land after the filter narrowed the set, leaving
  // `selected` momentarily past the end until the next keystroke re-clamps it (foldMentionKey clamps on move).
  const selected =
    visible.length === 0 ? 0 : Math.max(0, Math.min(state.selected, visible.length - 1));
  const where = state.dir.length === 0 ? './' : `${sanitizeInline(state.dir)}/`;
  const { start, end } = mentionWindow(visible.length, selected);
  const windowed = visible.slice(start, end);
  // The body: a "loading…" hint, a "no matching file" hint, or the windowed candidate rows — as early-return
  // branches (not a nested ternary) so the JSX stays scannable.
  const renderBody = (): ReactNode => {
    if (state.loading) {
      return (
        <Text {...dimProps(color)} wrap="truncate-end">
          loading…
        </Text>
      );
    }
    if (visible.length === 0) {
      return (
        <Text {...dimProps(color)} wrap="truncate-end">
          no matching file
        </Text>
      );
    }
    return windowed.map((candidate, index) => {
      const isSelected = start + index === selected;
      const marker = candidate.type === 'directory' ? '/' : '';
      return (
        <Text
          key={candidate.path}
          {...(isSelected ? colorProps(color, 'cyan') : {})}
          wrap="truncate-end"
        >
          {`${isSelected ? '›' : ' '} ${sanitizeInline(candidate.name)}${marker}`}
        </Text>
      );
    });
  };
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
        {`@ ${where}`}
        <Text bold>{sanitizeInline(state.filter)}</Text>
      </Text>
      {renderBody()}
      <Text {...dimProps(color)} wrap="truncate-end">
        ↑/↓ select · Enter open/insert · Esc cancel
      </Text>
    </Box>
  );
}
