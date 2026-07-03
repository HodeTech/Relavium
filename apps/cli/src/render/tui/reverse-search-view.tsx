import { Text } from 'ink';
import type { ReactElement } from 'react';

import { sanitizeInline } from './chat-projection.js';
import { reverseSearchMatchText, type ReverseSearchState } from './input-history.js';
import { colorProps } from './projection.js';

/**
 * The `Ctrl+R` reverse-incremental-search line (2.5.D step 3) — a readline-style `(reverse-i-search)` prompt that
 * replaces the idle prompt while the submode is open (like the `/` palette). Shows the query + the current match;
 * a query with no match reads `(failed reverse-i-search)`. Both the query and the match are sanitized at this
 * display boundary so a recalled control sequence cannot corrupt the terminal.
 */
export function ReverseSearchView(
  props: Readonly<{ state: ReverseSearchState; entries: readonly string[]; color: boolean }>,
): ReactElement {
  const { state, entries, color } = props;
  const match = reverseSearchMatchText(entries, state);
  const failed = state.query.length > 0 && match === undefined;
  return (
    <Text {...colorProps(color, failed ? 'yellow' : 'cyan')} wrap="truncate-end">
      {failed ? '(failed reverse-i-search)`' : '(reverse-i-search)`'}
      {sanitizeInline(state.query)}
      {`': ${match !== undefined ? sanitizeInline(match) : ''}`}
    </Text>
  );
}
