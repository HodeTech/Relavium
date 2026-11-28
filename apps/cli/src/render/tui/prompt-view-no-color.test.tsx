import './force-color.js';

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { PromptEditor } from './prompt-view.js';

/**
 * "No colour" means colour only (ADR-0145 §5, MVP-11 OD-6): bold, inverse and underline stay, so the prompt keeps a visible cursor under
 * `NO_COLOR` (it had none: observed, MVP-11 step 1 evidence §A·H). The CLI gates colour with its own flag (`color`) and ink's `inverse`
 * does not read `NO_COLOR`, so the cell must be drawn inverse whatever `color` says. `./force-color.js` comes first so that chalk emits
 * real sequences and the frame can be read: the assertions look at the emitted `ESC[7m` … `ESC[27m`, not at a prop.
 */
const INVERSE_OPEN = '\x1b[7m';
const INVERSE_CLOSE = '\x1b[27m';

function frameOf(text: string, cursor: number, color: boolean): string {
  const view = render(<PromptEditor editor={{ text, cursor }} color={color} />);
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

describe('the prompt cursor without colour', () => {
  it('is an inverse cell at the end of a row, with colour off', () => {
    const frame = frameOf('hello', 5, false);
    expect(frame).toContain(`hello${INVERSE_OPEN} ${INVERSE_CLOSE}`);
  });

  it('is an inverse cell on an empty prompt, with colour off', () => {
    const frame = frameOf('', 0, false);
    expect(frame).toContain(`> ${INVERSE_OPEN} ${INVERSE_CLOSE}`);
  });

  it('is the inverse character under the cursor in the middle of a row, with colour off', () => {
    const frame = frameOf('hello', 1, false);
    expect(frame).toContain(`h${INVERSE_OPEN}e${INVERSE_CLOSE}llo`);
  });

  it('adds no colour of its own with colour off: no foreground sequence anywhere in the frame', () => {
    const frame = frameOf('hello', 5, false);
    // eslint-disable-next-line no-control-regex -- the point of the assertion is the escape byte
    expect(frame).not.toMatch(/\x1b\[(?:3[0-79]|9[0-7])m/u);
  });

  it('is the same inverse cell with colour on (the cell is not what colour switches)', () => {
    const frame = frameOf('hello', 5, true);
    expect(frame).toContain(`${INVERSE_OPEN} ${INVERSE_CLOSE}`);
  });
});
