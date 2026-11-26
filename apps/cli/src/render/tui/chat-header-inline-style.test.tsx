import './force-color.js';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { emitChatHeader } from './chat-ink.js';
import { WORDMARK } from './home-layout.js';
import { mountHostedChat, mountStandaloneChat } from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * OB7-L8 (the observation of unit 7's chat half): the INLINE header was written in two styles. The stand-alone chat writes it before it mounts, in
 * bold only (`emitChatHeader`); the chat the Home hosts printed it through `<Static>` in bold CYAN. Inline has no fixed top row, the header scrolls
 * into the terminal's own history among the transcript, and an accent that the same chat does not carry in the other host reads as two products.
 * Both are bold only now (the full-screen header, a frame's own first row, keeps the accent).
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const variant = (renderer: 'alt' | 'inline'): Variant => ({
  renderer,
  color: true,
  size: { cols: 100, rows: 30 },
});

/** The cells of the wordmark's letters on the row that holds it, with how each was drawn. */
function wordmarkStyles(
  cells: ReturnType<Awaited<ReturnType<typeof mountHostedChat>>['cells']>,
): readonly { readonly bold: boolean; readonly fg: string | undefined }[] {
  const row = cells.find((line) =>
    line
      .map((cell) => cell.char)
      .join('')
      .startsWith(WORDMARK),
  );
  expect(row, 'the wordmark is on a row').toBeDefined();
  return (row ?? [])
    .slice(0, WORDMARK.length)
    .filter((cell) => cell.char.trim() !== '')
    .map((cell) => ({ bold: cell.style.bold, fg: cell.style.fg }));
}

describe('the inline header is bold and has no colour, in both hosts', () => {
  it('the chat the Home hosts prints it bold, with no foreground colour', async () => {
    const m = await mountHostedChat(variant('inline'), {
      hosted: { session: { provider: 'anthropic' } },
    });
    try {
      await m.settle();
      const styles = wordmarkStyles(m.cells());
      expect(styles.length).toBeGreaterThan(5);
      expect(styles.every((cell) => cell.bold)).toBe(true);
      expect(styles.map((cell) => cell.fg)).toEqual(styles.map(() => undefined));
    } finally {
      m.unmount();
    }
  });

  it('the stand-alone chat writes it bold, with no colour sequence', () => {
    const written: string[] = [];
    emitChatHeader(false, {}, (text) => written.push(text));
    const bytes = written.join('');
    expect(bytes).toContain(`${ESC}[1m`);
    expect(bytes).toContain(WORDMARK);
    expect(bytes, 'no foreground colour').not.toMatch(
      new RegExp(`${ESC}\\[(?:3[0-7]|9[0-7]|38)`, 'u'),
    );
  });

  it('the full-screen header, the first row of a frame, keeps the accent', async () => {
    const m = mountStandaloneChat(variant('alt'), { standalone: { provider: 'anthropic' } });
    try {
      await m.settle();
      const styles = wordmarkStyles(m.cells());
      expect(styles.every((cell) => cell.bold)).toBe(true);
      expect(styles.every((cell) => cell.fg !== undefined)).toBe(true);
    } finally {
      m.unmount();
    }
  });
});
