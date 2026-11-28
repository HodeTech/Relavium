import './force-no-color.js';

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { PromptEditor } from './prompt-view.js';

/**
 * The prompt's props where CHALK is at level 0 (`--no-color`, `FORCE_COLOR=0`, `TERM=dumb`; the condition `force-no-color.js` creates, and
 * `prompt-view-chalk-off.test.tsx` proves with a control): ink's own `inverse` and `dimColor` print nothing there, so the placeholder's cursor
 * cell has to be the SGR pair this view writes itself, whatever the CLI's own colour flag says, and the placeholder must read without dim.
 */
const INVERSE_OPEN = '\u001b[7m';
const INVERSE_CLOSE = '\u001b[27m';
const DIM_OPEN = '\u001b[2m';

function frameOf(color: boolean, cursor = true): string {
  const view = render(
    <PromptEditor
      editor={{ text: '', cursor: 0 }}
      color={color}
      glyph={color ? '›' : '>'}
      placeholder="reply to continue"
      cursor={cursor}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

describe('the placeholder of the prompt where chalk is off', () => {
  it.each([false, true])(
    'keeps its cursor cell on the first character with the colour flag %s: the cell is written by the view, not asked of chalk',
    (color) => {
      expect(frameOf(color)).toContain(`${INVERSE_OPEN}r${INVERSE_CLOSE}eply to continue`);
    },
  );

  it('draws no dim anywhere and no colour of its own, so the invitation reads as words', () => {
    const frame = frameOf(false);
    expect(frame).not.toContain(DIM_OPEN);
    // eslint-disable-next-line no-control-regex -- the point of the assertion is the escape byte
    expect(frame).not.toMatch(/\u001b\[(?:3[0-79]|9[0-7])m/u);
  });

  it('draws no cell at all when the cursor is off', () => {
    expect(frameOf(false, false)).not.toContain(INVERSE_OPEN);
  });
});
