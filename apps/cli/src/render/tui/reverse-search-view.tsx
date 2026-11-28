import { Box } from 'ink';
import { Text } from './text.js';
import type { ReactElement } from 'react';

import { sanitizeInline } from '../sanitize.js';
import { screenText } from './screen-text.js';
import { Emph } from './emphasis-view.js';
import { reverseSearchMatchText, type ReverseSearchState } from './input-history.js';
import { exitKey, legend } from './legend.js';
import { colorProps, dimProps } from './projection.js';
import { clipPieces } from './sheet-frame.js';

/** The hint under the search line: `Esc` leaves the search, and the draft it replaced is as it was (ADR-0145 §2, close). */
const SEARCH_LEGEND = legend(
  [
    { keys: 'Ctrl+R', verb: 'older' },
    { keys: 'Enter', verb: 'accept' },
  ],
  exitKey.close(),
);

/**
 * A stored line (the query and the recalled history line) as the screen draws it: the inline sanitiser, then the screen's filter (unit 9, review round
 * 2, S2-5): a recalled line is stored text, and a filler a terminal draws wider than the layout counts would wrap the row into the margin. The row
 * is cut to the view's columns by the layout's measure before ink sees it (review round 5).
 */
const screenName = (stored: string): string => screenText(sanitizeInline(stored));

/**
 * The `Ctrl+R` reverse-incremental-search line (2.5.D step 3) — a readline-style search prompt that replaces the
 * idle prompt while the submode is open (like the `/` palette, whose spacing + trailing hint line it mirrors).
 * Shows the (bold) query and, dimmed, the current match; a query with no match reads `(failed reverse-i-search)`.
 * Both the query and the match are sanitized at this display boundary so a recalled control sequence cannot
 * corrupt the terminal, and are visually distinguished from the literal framing so neither can be mistaken for it.
 */
export function ReverseSearchView(
  props: Readonly<{
    state: ReverseSearchState;
    entries: readonly string[];
    color: boolean;
    /** The columns the row is drawn in (every host passes it): the row is cut to them by the layout's measure, so ink never fits it. */
    columns?: number | undefined;
  }>,
): ReactElement {
  const { state, entries, color } = props;
  const match = reverseSearchMatchText(entries, state);
  const failed = state.query.length > 0 && match === undefined;
  const pieces = [
    failed ? '(failed reverse-i-search) ' : '(reverse-i-search) ',
    screenName(state.query),
    match === undefined ? '' : ` → ${screenName(match)}`,
  ];
  const [lead = '', query = '', found = ''] =
    props.columns === undefined ? pieces : clipPieces(pieces, Math.max(1, props.columns));
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      <Text {...colorProps(color, failed ? 'yellow' : 'cyan')} wrap="truncate-end">
        {lead}
        <Emph kinds="bold">{query}</Emph>
        {found !== '' && <Text {...dimProps(color)}>{found}</Text>}
      </Text>
      <Text {...dimProps(color)} wrap="truncate-end">
        {SEARCH_LEGEND}
      </Text>
    </Box>
  );
}
