/**
 * The text of the report popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8):
 * the width every report line is written for, the one wrap, and the scrub every untrusted string passes.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { REPORT_TEXT_COLUMNS, reportText, wrapHanging, wrapReport } from './report-text.js';

describe('the width', () => {
  it('is the inner width of a standard popup at the 80-column floor: 66', () => {
    expect(REPORT_TEXT_COLUMNS).toBe(66);
    expect(REPORT_TEXT_COLUMNS).toBe(POPUP_NOTICE_MAX_COLUMNS);
  });
});

describe('wrapReport', () => {
  it('breaks between words, at most `columns` wide, and ends no line with a space', () => {
    const lines = wrapReport('one two three four five six', 12);
    expect(lines).toEqual(['one two', 'three four', 'five six']);
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });

  it('breaks a word wider than the room where it must, and loses nothing', () => {
    const lines = wrapReport(`x${'y'.repeat(30)}z`, 10);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.join('')).toBe(`x${'y'.repeat(30)}z`);
  });

  it('uses the popup’s width when it is not given one', () => {
    const lines = wrapReport('word '.repeat(40));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(REPORT_TEXT_COLUMNS);
  });
});

describe('wrapHanging', () => {
  it('keeps a text that fits as one line, and indents what continues under its first line by `hang`', () => {
    expect(wrapHanging('short row', 20)).toEqual(['short row']);
    expect(wrapHanging('aaaa bbbb cccc dddd', 10, 4)).toEqual([
      'aaaa bbbb',
      '    cccc',
      '    dddd',
    ]);
  });

  it('indents by four columns unless told otherwise, and never lets a continuation pass the width', () => {
    const lines = wrapHanging(`${'word '.repeat(30)}end`, 30);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(1)) expect(line.startsWith('    ')).toBe(true);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
    expect(lines.join(' ').replaceAll(/\s+/gu, ' ')).toBe(`${'word '.repeat(30)}end`);
  });
});

describe('reportText', () => {
  it('takes the escapes, the forged key tokens and separators out of a string a project wrote', () => {
    const scrubbed = reportText('a\u001b[31m [Ctrl+Y] allow · [d] b');
    expect(scrubbed).not.toContain('\u001b');
    expect(scrubbed).not.toContain('[Ctrl+Y]');
    expect(scrubbed).not.toContain(' · ');
    expect(scrubbed).not.toContain('[d]');
    expect(scrubbed.startsWith('a')).toBe(true);
    expect(scrubbed.endsWith('b')).toBe(true);
  });
});
