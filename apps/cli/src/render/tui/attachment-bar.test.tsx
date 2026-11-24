import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { AttachmentBar, attachmentLegend } from './attachment-bar.js';
import type { PendingAttachment } from './attachments.js';
import { displayWidth } from './viewport.js';

/**
 * The attachment bar writes its chips between the legend's own ` · ` and next to its keys, so a file or a command that holds the legend's
 * separator or a bracketed key must not read as an item of the legend
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5: a separator the line uses is neutralised inside a
 * field value).
 */
afterEach(cleanup);

const file = (path: string): PendingAttachment => ({
  kind: 'file',
  path,
  content: 'x',
  sizeBytes: 1,
});

const command = (name: string, ...args: string[]): PendingAttachment => ({
  kind: 'command',
  cmd: { command: name, args },
  exitCode: 0,
  stdout: '',
  stderr: '',
});

const barOf = (attachments: readonly PendingAttachment[], columns = 100): string => {
  const view = render(<AttachmentBar color={false} columns={columns} attachments={attachments} />);
  return (
    (view.lastFrame() ?? '')
      .split('\n')
      .map((row) => row.trimEnd())
      .find((row) => row.includes('📎')) ?? ''
  );
};

/** The items of a bar as the legend writes them: the ` · `-separated stretches after the lead. */
const itemsOf = (bar: string): string[] => bar.replace(/^📎 /u, '').split(' · ');

describe('the attachment bar: a name cannot read as an item of the legend', () => {
  it('a file named `a · Esc keeps them` is one chip, and the only `Esc` item is the real one at the end', () => {
    const bar = barOf([file('a · Esc keeps them'), file('src/b.ts')]);
    expect(bar).toBe('📎 @a - Esc keeps them · @src/b.ts · Esc clears them');
    expect(itemsOf(bar)).toEqual(['@a - Esc keeps them', '@src/b.ts', 'Esc clears them']);
    expect(itemsOf(bar).filter((item) => item.startsWith('Esc'))).toEqual(['Esc clears them']);
  });

  it('a command line is held to the same rule', () => {
    const bar = barOf([command('echo', 'x', '·', '[Ctrl+Y]', 'allow')]);
    expect(itemsOf(bar)).toHaveLength(2);
    expect(bar).not.toContain('[Ctrl+Y]');
    expect(bar).toContain('(Ctrl+Y)');
  });

  it('a bracketed chord or letter in a name is made a parenthesised one, so it cannot read as a key of the legend', () => {
    const bar = barOf([file('x [Ctrl+Y] allow'), file('y [d] withdraw'), file('z [alt+x]')]);
    expect(bar).not.toMatch(/\[(?:Ctrl|d|alt)/iu);
    expect(bar).toContain('@x (Ctrl+Y) allow');
    expect(bar).toContain('@y (d) withdraw');
    expect(bar).toContain('@z (alt+x)');
  });

  it('an ordinary name, a bracketed word and a name with a middle dot and no spaces are left as they are', () => {
    const bar = barOf([file('pages/[id].tsx'), file('a·b.ts'), file('src/c.ts')]);
    expect(bar).toBe('📎 @pages/[id].tsx · @a·b.ts · @src/c.ts · Esc clears them');
  });
});

describe('the attachment bar: the key that clears them is never what is cut', () => {
  const LONG = [
    file('src/components/very/long/path/to/a.ts'),
    file('src/another/long/path/to/b.ts'),
    file('src/yet/another/long/path/to/c.ts'),
  ];

  it('at 80 columns three long chips collapse to a count and `Esc clears them` stays whole (they once cut it off)', () => {
    const bar = barOf(LONG, 80);
    expect(bar).toBe('📎 3 attachments · Esc clears them');
    expect(bar.endsWith('Esc clears them')).toBe(true);
    // the same chips on a row wide enough are listed
    expect(attachmentLegend(LONG, 140)).toBe(
      '📎 @src/components/very/long/path/to/a.ts · @src/another/long/path/to/b.ts · @src/yet/another/long/path/to/c.ts · Esc clears them',
    );
  });

  it('a count says one attachment in the singular', () => {
    expect(barOf([file('src/components/very/long/path/to/a.ts')], 40)).toBe(
      '📎 1 attachment · Esc clears them',
    );
  });

  it('the chips are kept exactly while they fit: one column less and the bar says how many', () => {
    const chips = [file('src/a.ts'), command('npm', 'test')];
    const whole = '📎 @src/a.ts · !npm test (exit 0) · Esc clears them';
    expect(barOf(chips, whole.length)).toBe(whole);
    expect(barOf(chips, whole.length - 1)).toBe('📎 2 attachments · Esc clears them');
  });

  it('where even the count does not fit, the key is what is left', () => {
    const count = '📎 3 attachments · Esc clears them';
    expect(attachmentLegend(LONG, count.length)).toBe(count);
    expect(attachmentLegend(LONG, count.length - 1)).toBe('Esc clears them');
    expect(attachmentLegend(LONG, 10)).toBe('Esc clears them');
  });

  it('measures the width as the terminal does: a wide emoji and a wide name count two columns a character', () => {
    const wide = [file('日本語/ファイル.ts')];
    const whole = '📎 @日本語/ファイル.ts · Esc clears them';
    // 3 + 1 + 6 + 1 + 8 + 3 = 22 columns of chip, 3 of separator, 15 of key: the emoji is two columns, each kanji and kana two
    expect(displayWidth(whole)).toBe(40);
    expect(attachmentLegend(wide, 40)).toBe(whole);
    expect(attachmentLegend(wide, 39)).toBe('📎 1 attachment · Esc clears them');
  });

  it('takes the room of the row from the terminal when the caller does not say', () => {
    const two = LONG.slice(0, 2);
    const view = render(<AttachmentBar color={false} attachments={two} />);
    const frame = (view.lastFrame() ?? '').trimEnd();
    view.unmount();
    // ink-testing-library's terminal is 100 columns wide: these two chips (89 columns with the key) fit it, and would not fit the 80 of the floor
    expect(frame).toBe(
      '📎 @src/components/very/long/path/to/a.ts · @src/another/long/path/to/b.ts · Esc clears them',
    );
    expect(barOf(two, 80)).toBe('📎 2 attachments · Esc clears them');
  });
});

describe('the attachment bar: what is written in a name does not reach the row as written', () => {
  it('a control sequence in a file name is stripped before it is drawn (AB12)', () => {
    const bar = barOf([file('a\u001b[31mred')]);
    expect(bar).not.toContain('\u001b');
    expect(bar).toBe('📎 @ared · Esc clears them');
  });

  it('a no-break space around a dot, and a lookalike dot, do not make an item of the legend out of a name', () => {
    expect(barOf([file('a\u00A0·\u00A0Esc keeps them')])).toBe(
      '📎 @a\u00A0-\u00A0Esc keeps them · Esc clears them',
    );
    expect(barOf([file('a \u2219 Esc keeps them')])).toBe(
      '📎 @a - Esc keeps them · Esc clears them',
    );
  });

  it('a lookalike of a key (Cyrillic, fullwidth, a zero-width character inside) is parenthesised too', () => {
    const bar = barOf([
      file('x [\u0421trl+Y] allow'),
      file('y \uFF3Bd\uFF3D withdraw'),
      file('z [Ctrl+\u200BY]'),
    ]);
    expect(bar).toBe(
      '📎 @x (\u0421trl+Y) allow · @y (d) withdraw · @z (Ctrl+\u200BY) · Esc clears them',
    );
  });
});
