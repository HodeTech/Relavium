import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { MentionView } from './mention-view.js';
import { selectedTone, selectionMarker } from './selectable-text.js';

/**
 * The one place a list row's "selected" look is decided ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5): the
 * selected row is cyan (with colour on) and carries the marker; every other row has no colour of its own and a blank marker column. A rule that gave
 * every row the selected look would pass a test that only ever looks at the selected row.
 */
afterEach(cleanup);

const CYAN = '\u001b[36m';

describe('selectedTone and selectionMarker', () => {
  it('colour the selected row cyan and no other, with colour on', () => {
    expect(selectedTone(true, true)).toEqual({ color: 'cyan' });
    expect(selectedTone(false, true)).toEqual({});
    expect(selectedTone(undefined, true)).toEqual({});
  });

  it('give an unselected row neither a colour nor a marker, with colour off or on', () => {
    expect(selectedTone(true, false)).toEqual({});
    expect(selectionMarker(false, true)).toBe(' ');
    expect(selectionMarker(undefined, false)).toBe(' ');
    expect(selectionMarker(true, true)).not.toBe(' ');
    expect(selectionMarker(true, false)).not.toBe(' ');
  });
});

describe('a list that uses them', () => {
  it('draws the selected row of the @ list cyan and an unselected one with no colour of its own', () => {
    const view = render(
      <MentionView
        state={{
          dir: '',
          filter: '',
          candidates: [
            { name: 'src', type: 'directory', path: 'src' },
            { name: 'app.ts', type: 'file', path: 'app.ts' },
          ],
          selected: 0,
          loading: false,
        }}
        color
      />,
    );
    const lines = (view.lastFrame() ?? '').split('\n');
    view.unmount();
    const selected = lines.find((line) => line.includes('src/')) ?? '';
    const other = lines.find((line) => line.includes('app.ts')) ?? '';
    expect(selected, 'the selected row is found').toContain('src/');
    expect(selected).toContain(CYAN);
    expect(other, 'the unselected row is found').toContain('app.ts');
    expect(other).not.toContain(CYAN);
  });
});
