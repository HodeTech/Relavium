import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { sanitizeInline } from './chat-projection.js';
import { reverseSearchMatchText, type ReverseSearchState } from './input-history.js';
import { colorProps, dimProps } from './projection.js';

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
    <Box flexDirection="column" marginTop={1}>
      <Text {...colorProps(color, failed ? 'yellow' : 'cyan')} wrap="truncate-end">
        {failed ? '(failed reverse-i-search) ' : '(reverse-i-search) '}
        <Text bold>{sanitizeInline(state.query)}</Text>
        {match !== undefined && <Text {...dimProps(color)}>{` → ${sanitizeInline(match)}`}</Text>}
      </Text>
      <Text {...dimProps(color)} wrap="truncate-end">
        Ctrl+R older · Enter accept · Esc cancel
      </Text>
    </Box>
  );
}
