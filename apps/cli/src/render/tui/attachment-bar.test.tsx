import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { AttachmentBar } from './attachment-bar.js';
import type { PendingAttachment } from './attachments.js';

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

const barOf = (attachments: readonly PendingAttachment[]): string => {
  const view = render(<AttachmentBar color={false} attachments={attachments} />);
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
