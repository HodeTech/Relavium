import './force-color.js';

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { PromptEditor } from './prompt-view.js';

/**
 * The three optional props of the prompt ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §1 and §4, MVP-11 step 7a): `glyph` (the first row's prefix), `placeholder` (the invitation of an EMPTY prompt, never part of its text) and
 * `cursor` (whether the cell is drawn). Every default keeps today's bytes for the prompt's other callers (the Home's body and the native card's
 * filter). Chalk is forced to truecolor here so that the frame carries its SGR and can be read; `prompt-view-props-chalk-off.test.tsx` is the
 * same proof where chalk is at level 0.
 */
const INVERSE_OPEN = '\u001b[7m';
const INVERSE_CLOSE = '\u001b[27m';
const DIM_OPEN = '\u001b[2m';
// eslint-disable-next-line no-control-regex -- the point of the helper is the escape byte
const SGR = /\u001b\[[0-9;]*m/gu;
const plain = (frame: string): string => frame.replace(SGR, '');

type Props = Parameters<typeof PromptEditor>[0];

function frameOf(props: Props): string {
  const view = render(<PromptEditor {...props} />);
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

const empty = { text: '', cursor: 0 };

describe('the glyph of the prompt', () => {
  it('is the literal `> ` it has always drawn when none is given: the same bytes for a caller that passes nothing', () => {
    const before = frameOf({ editor: { text: 'hello', cursor: 5 }, color: true });
    expect(plain(before)).toBe('> hello ');
    expect(frameOf({ editor: { text: 'hello', cursor: 5 }, color: true, glyph: undefined })).toBe(
      before,
    );
    expect(frameOf({ editor: { text: 'a\nb', cursor: 3 }, color: true })).toBe(
      frameOf({ editor: { text: 'a\nb', cursor: 3 }, color: true, glyph: undefined }),
    );
  });

  it('is the prefix of the FIRST row only, and a continuation row hangs under the text', () => {
    expect(
      plain(frameOf({ editor: { text: 'one\ntwo', cursor: 7 }, color: true, glyph: '›' })),
    ).toBe('› one\n  two ');
    expect(
      plain(frameOf({ editor: { text: 'one\ntwo', cursor: 7 }, color: false, glyph: '>' })),
    ).toBe('> one\n  two ');
  });
});

describe('the placeholder of an empty prompt', () => {
  it('is drawn when the text is empty: the cursor on its first character, the rest dim', () => {
    const frame = frameOf({
      editor: empty,
      color: true,
      glyph: '›',
      placeholder: 'reply to continue',
    });
    expect(plain(frame)).toBe('› reply to continue');
    expect(frame).toContain(`${INVERSE_OPEN}r${INVERSE_CLOSE}`);
    expect(frame).toContain(`${DIM_OPEN}eply to continue`);
  });

  it('is never drawn beside a draft: the first character typed replaces it', () => {
    const frame = frameOf({
      editor: { text: 'h', cursor: 1 },
      color: true,
      glyph: '›',
      placeholder: 'reply to continue',
    });
    expect(plain(frame)).toBe('› h ');
    expect(frame).not.toContain('reply');
  });

  it('is plain without colour, because dim cannot be trusted, and the cursor is still the inverse cell', () => {
    const frame = frameOf({
      editor: empty,
      color: false,
      glyph: '>',
      placeholder: 'reply to continue',
    });
    expect(plain(frame)).toBe('> reply to continue');
    expect(frame, 'no dim sequence at all').not.toContain(DIM_OPEN);
    expect(frame).toContain(`${INVERSE_OPEN}r${INVERSE_CLOSE}`);
  });

  it('draws no cursor cell when the cursor is off, and is then dim whole', () => {
    const frame = frameOf({
      editor: empty,
      color: true,
      glyph: '›',
      placeholder: 'reply to continue',
      cursor: false,
    });
    expect(plain(frame)).toBe('› reply to continue');
    expect(frame).not.toContain(INVERSE_OPEN);
    expect(frame).toContain(`${DIM_OPEN}reply to continue`);
  });

  it('is scrubbed like every other segment of the prompt: a control sequence in it never reaches the terminal', () => {
    const frame = frameOf({
      editor: empty,
      color: false,
      placeholder: `a\u001b[31mb\u001b]0;pwned\u0007c`,
    });
    expect(frame).not.toContain('\u001b[31m');
    expect(frame).not.toContain('\u001b]');
    expect(frame).not.toContain('\u0007');
  });

  it('is nothing the editor knows: the editor’s own text stays empty, so there is nothing to send or to record', () => {
    const editor = { text: '', cursor: 0 };
    frameOf({ editor, color: true, placeholder: 'summarize the files in this folder' });
    expect(editor).toEqual({ text: '', cursor: 0 });
  });
});

describe('the cursor flag of the prompt', () => {
  it('draws the cell by default and when it is true', () => {
    const base = frameOf({ editor: { text: 'hello', cursor: 5 }, color: true });
    expect(base).toContain(`hello${INVERSE_OPEN} ${INVERSE_CLOSE}`);
    expect(frameOf({ editor: { text: 'hello', cursor: 5 }, color: true, cursor: true })).toBe(base);
  });

  it('draws the text and no cell when it is false: the bytes the out-of-range cursor used to give', () => {
    const off = frameOf({ editor: { text: 'hello', cursor: 5 }, color: true, cursor: false });
    expect(plain(off)).toBe('> hello');
    expect(off).not.toContain(INVERSE_OPEN);
    expect(off).toBe(frameOf({ editor: { text: 'hello', cursor: -1 }, color: true }));
  });

  it('keeps every row of a multi-line draft when it is false, and still hangs them under the glyph', () => {
    const off = frameOf({
      editor: { text: 'one\ntwo', cursor: 4 },
      color: true,
      glyph: '›',
      cursor: false,
    });
    expect(plain(off)).toBe('› one\n  two');
    expect(off).not.toContain(INVERSE_OPEN);
  });
});
