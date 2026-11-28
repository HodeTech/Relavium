/**
 * `SelectableNote` (the dimmed words of a row, MVP-11 unit 7): the words are inverse with the row when it is selected (SGR 7), and not
 * otherwise, whether `selected` is `false` or absent. A note that was inverse on every row, or on none, passes a test that only ever looks at
 * one kind of row.
 */
import './force-color.js';

import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { SelectableNote } from './selectable-text.js';

afterEach(cleanup);

const INVERSE = `${String.fromCharCode(27)}[7m`;

function frameOf(selected: boolean | undefined): string {
  const view = render(
    <Text>
      <SelectableNote selected={selected}>words</SelectableNote>
    </Text>,
  );
  const out = view.lastFrame() ?? '';
  view.unmount();
  return out;
}

describe('SelectableNote: the dimmed words of a selected row are inverse, and an unselected one is not', () => {
  it('a selected row’s note is inverse, and still says its words', () => {
    const selected = frameOf(true);
    expect(selected).toContain(INVERSE);
    expect(selected).toContain('words');
  });

  it.each([false, undefined] as const)(
    'a note with selected %s is not inverse, and still says its words',
    (selected) => {
      const frame = frameOf(selected);
      expect(frame).not.toContain(INVERSE);
      expect(frame).toContain('words');
    },
  );
});
