import { Box } from 'ink';
import { Text } from './text.js';
import type { ReactElement, ReactNode } from 'react';

import { sanitizeInline } from '../sanitize.js';
import { Emph } from './emphasis-view.js';
import { exitKey, legend } from './legend.js';
import { visibleMentions, type MentionState } from './mention.js';
import { withGlyphForm } from './glyphs.js';
import { colorProps, dimProps } from './projection.js';
import { screenText } from './screen-text.js';
import { inkSafe } from './viewport.js';
import { SelectableText, selectedTone, selectionMarker } from './selectable-text.js';
import { markedWindow, windowMarkers, type MarkedWindow } from './sheet-frame.js';

/** The most candidate rows shown at once — a directory with hundreds of entries scrolls a window around the
 *  selection rather than flooding the terminal (the palette renders all; a directory listing can be far larger). */
export const MENTION_WINDOW = 8;

/** The hint under the candidates (ADR-0145 §3): `Esc` closes the completion and the `@` comes back into the draft; nothing else changes. */
const MENTION_LEGEND = legend(
  [
    { keys: '↑/↓', verb: 'select' },
    { keys: 'Enter', verb: 'open/insert' },
  ],
  exitKey.close(),
);

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
  /** The rows of the candidate window ({@link MENTION_WINDOW} when absent): the Home fits it to the room its page leaves. */
  readonly windowRows?: number | undefined;
  /**
   * How a stored name (a candidate, the browsed directory) is drawn: the chat's inline sanitiser when absent; the Home passes its full row
   * scrub (`homeMentionText`), as it does for every stored name it draws beside its keys.
   */
  readonly text?: ((stored: string) => string) | undefined;
  /** Whether the view draws its own legend row and the blank row above it (the chat's); the Home draws the legend on its hint row. Default `true`. */
  readonly framed?: boolean | undefined;
}

/** The window of candidate indices to render around `selected` (a `[start, end)` slice) of `size` rows ({@link MENTION_WINDOW} by default), keeping
 *  the selection visible, with the `▲`/`▼ N more` markers for what it hides (they take the window's first and last row, so its height does not
 *  change). Pure so the scroll math is unit-checkable. */
export function mentionWindow(
  count: number,
  selected: number,
  size: number = MENTION_WINDOW,
): MarkedWindow {
  return markedWindow(count, selected, size);
}

/** The rows the candidate list takes for `state` in a window of `size`: one for the loading and the empty line, else the window's. */
export function mentionListLines(state: MentionState, size: number = MENTION_WINDOW): number {
  if (state.loading) return 1;
  const count = visibleMentions(state).length;
  return count === 0 ? 1 : Math.min(count, Math.max(1, size));
}

/**
 * How the chat draws a stored name (a candidate, the browsed directory, the filter's echo): the inline sanitiser, then the screen's filter (unit 9,
 * review round 2, S2-5). A file name is the repository's, and a row of fillers a terminal draws wider than the layout counts would wrap at the right
 * edge and start the rest of the name at column 0. Ink cuts these rows itself, so a name is given in the form ink counts as a terminal draws it
 * ({@link inkSafe}: an Indic conjunct, review round 4, R4-S-1).
 */
const screenName = (stored: string): string => inkSafe(screenText(sanitizeInline(stored)));

export function MentionView(props: Readonly<MentionViewProps>): ReactElement {
  const { state, color } = props;
  const text = props.text ?? screenName;
  const framed = props.framed !== false;
  const visible = visibleMentions(state);
  // Clamp the highlighted index for display — an async listing can land after the filter narrowed the set, leaving
  // `selected` momentarily past the end until the next keystroke re-clamps it (foldMentionKey clamps on move).
  const selected =
    visible.length === 0 ? 0 : Math.max(0, Math.min(state.selected, visible.length - 1));
  const where = state.dir.length === 0 ? './' : `${inkSafe(text(state.dir))}/`;
  const span = mentionWindow(
    visible.length,
    selected,
    Math.max(1, props.windowRows ?? MENTION_WINDOW),
  );
  const { start, end } = span;
  const { above, below } = withGlyphForm(!color, () => windowMarkers(span));
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
      // The first and last row of a window that hides candidates stand for them: `▲ 3 more`, the candidate under it counted.
      const marker = index === 0 ? above : index === windowed.length - 1 ? below : undefined;
      if (marker !== undefined)
        return (
          <Text key={marker} {...dimProps(color)} wrap="truncate-end">
            {`  ${marker}`}
          </Text>
        );
      const isSelected = start + index === selected;
      const slash = candidate.type === 'directory' ? '/' : '';
      return (
        <Text key={candidate.path} {...selectedTone(isSelected, color)} wrap="truncate-end">
          <SelectableText selected={isSelected}>
            {`${selectionMarker(isSelected, color)} ${inkSafe(text(candidate.name))}${slash}`}
          </SelectableText>
        </Text>
      );
    });
  };
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={framed ? 1 : 0}>
      <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
        {`@ ${where}`}
        <Emph kinds="bold">{screenName(state.filter)}</Emph>
      </Text>
      {renderBody()}
      {framed && (
        <Text {...dimProps(color)} wrap="truncate-end">
          {MENTION_LEGEND}
        </Text>
      )}
    </Box>
  );
}
