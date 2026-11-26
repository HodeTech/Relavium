import { Box } from 'ink';
import { Text } from './text.js';
import type { ReactElement } from 'react';

import { sanitizeInline } from '../sanitize.js';
import { Emph } from './emphasis-view.js';
import { reverseSearchMatchText, type ReverseSearchState } from './input-history.js';
import { exitKey, legend } from './legend.js';
import { colorProps, dimProps } from './projection.js';

/** The hint under the search line: `Esc` leaves the search, and the draft it replaced is as it was (ADR-0145 §2, close). */
const SEARCH_LEGEND = legend(
  [
    { keys: 'Ctrl+R', verb: 'older' },
    { keys: 'Enter', verb: 'accept' },
  ],
  exitKey.close(),
);

/**
 * The `Ctrl+R` reverse-incremental-search line (2.5.D step 3) — a readline-style search prompt that replaces the
 * idle prompt while the submode is open (like the `/` palette, whose spacing + trailing hint line it mirrors).
 * Shows the (bold) query and, dimmed, the current match; a query with no match reads `(failed reverse-i-search)`.
 * Both the query and the match are sanitized at this display boundary so a recalled control sequence cannot
 * corrupt the terminal, and are visually distinguished from the literal framing so neither can be mistaken for it.
 */
export function ReverseSearchView(
  props: Readonly<{ state: ReverseSearchState; entries: readonly string[]; color: boolean }>,
): ReactElement {
  const { state, entries, color } = props;
  const match = reverseSearchMatchText(entries, state);
  const failed = state.query.length > 0 && match === undefined;
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      <Text {...colorProps(color, failed ? 'yellow' : 'cyan')} wrap="truncate-end">
        {failed ? '(failed reverse-i-search) ' : '(reverse-i-search) '}
        <Emph kinds="bold">{sanitizeInline(state.query)}</Emph>
        {match !== undefined && <Text {...dimProps(color)}>{` → ${sanitizeInline(match)}`}</Text>}
      </Text>
      <Text {...dimProps(color)} wrap="truncate-end">
        {SEARCH_LEGEND}
      </Text>
    </Box>
  );
}
