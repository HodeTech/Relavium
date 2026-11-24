import './force-no-color.js';

import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import { PromptEditor } from './prompt-view.js';

/**
 * The prompt cursor where CHALK is off (MVP-11 Step 2 review, C4): `--no-color` (argv), `FORCE_COLOR=0` and `TERM=dumb` leave chalk at level 0,
 * and ink renders `<Text inverse>` through chalk, so there the cell printed as a plain character and the prompt had no cursor. The sibling
 * test (`prompt-view-no-color.test.tsx`) imports `force-color.js`, which sets chalk to truecolor and so cannot see this path. THIS file imports
 * `force-no-color.js` first, which is the condition under test, and proves it took hold with a control: ink's own `inverse` prints nothing.
 */
const INVERSE_OPEN = '\u001b[7m';
const INVERSE_CLOSE = '\u001b[27m';
// eslint-disable-next-line no-control-regex -- the point of the helper is the escape byte
const SGR = /\u001b\[[0-9;]*m/gu;

function frameOf(text: string, cursor: number, color: boolean, width?: number): string {
  const view = render(
    width === undefined ? (
      <PromptEditor editor={{ text, cursor }} color={color} />
    ) : (
      <Box width={width}>
        <PromptEditor editor={{ text, cursor }} color={color} />
      </Box>
    ),
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

describe('the prompt cursor where chalk is off', () => {
  it('control: ink’s own <Text inverse> prints nothing here, which is the condition the cursor must survive', () => {
    const view = render(<Text inverse>x</Text>);
    expect(view.lastFrame()).toBe('x');
    view.unmount();
  });

  it('is still an inverse cell at the end of a row, with colour off', () => {
    expect(frameOf('hello', 5, false)).toContain(`hello${INVERSE_OPEN} ${INVERSE_CLOSE}`);
  });

  it('is still an inverse cell on an empty prompt, and over the character under it in the middle of a row', () => {
    expect(frameOf('', 0, false)).toContain(`> ${INVERSE_OPEN} ${INVERSE_CLOSE}`);
    expect(frameOf('hello', 1, false)).toContain(`h${INVERSE_OPEN}e${INVERSE_CLOSE}llo`);
  });

  it('adds no foreground colour of its own with colour off', () => {
    // eslint-disable-next-line no-control-regex -- the point of the assertion is the escape byte
    expect(frameOf('hello', 5, false)).not.toMatch(/\u001b\[(?:3[0-79]|9[0-7])m/u);
  });

  it('is zero-width: a row that exactly fills its width does not wrap for the SGR pair', () => {
    // `> ` + 8 characters + the cursor cell on the 9th column: 12 columns exactly, so any width counted for the escape bytes wraps it.
    const frame = frameOf('abcdefghij', 9, false, 12);
    const lines = frame.split('\n');
    expect(lines, 'one row').toHaveLength(1);
    expect(stringWidth(lines[0] ?? '')).toBe(12);
    expect(frame.replace(SGR, '')).toBe('> abcdefghij');
  });

  it('with colour on keeps ink’s own inverse (chalk off here, so it prints plain: the sequence is the host’s to add)', () => {
    // The two branches are told apart by what they emit when chalk cannot: ink's `inverse` adds nothing, the literal pair would.
    expect(frameOf('hello', 5, true)).not.toContain(INVERSE_OPEN);
  });
});
