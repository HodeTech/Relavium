/**
 * OB76 (unit 7, round 1): a notice on the landing must not move the prompt block. After `/mode` saved a default, `Global startup default saved: plan.`
 * brought a blank row above AND below itself, and the prompt went from row 11 to row 12 and the hint from 15 to 16 at 80×24 for the few seconds the
 * notice stayed. The notice now stands in the blank rows above the prompt, directly over it, with one blank row above it: a one-row notice under
 * the block moves nothing, and a taller one (or any under the one-line title, which has one blank row to give) moves the prompt by the rows it needs.
 */
import { describe, expect, it } from 'vitest';

import { mountHome, type HomeMount } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

const variantOf = (renderer: Variant['renderer'], rows = 24): Variant => ({
  renderer,
  color: false,
  size: { cols: 80, rows },
});

const NOTICE = 'Global startup default saved: plan.';
const promptRow = (frame: readonly string[]): number =>
  frame.findIndex((row) => /^ +> /u.test(row));
const hintRow = (frame: readonly string[]): number =>
  frame.findIndex((row) => row.includes('[Ctrl+C] exit (twice)'));

async function withNotice(
  m: HomeMount,
  text: string | undefined,
): Promise<{ closed: string[]; open: string[] }> {
  await m.settle();
  const closed = m.frame();
  m.controller.setProviderState(false, text);
  await m.settle();
  return { closed, open: m.frame() };
}

describe.each(['alt', 'inline'] as const)(
  'a notice on the landing in the %s renderer',
  (renderer) => {
    it('a one-row notice moves neither the prompt nor the hint, and stands directly over the prompt', async () => {
      const m = mountHome(variantOf(renderer));
      try {
        const { closed, open } = await withNotice(m, NOTICE);
        expect(promptRow(open), 'the prompt stays where it was').toBe(promptRow(closed));
        expect(hintRow(open), 'the hint stays where it was').toBe(hintRow(closed));
        expect(open.length).toBe(closed.length);
        const prompt = promptRow(open);
        expect(open[prompt - 1]?.trim(), 'the notice is the row over the prompt').toBe(NOTICE);
        expect(open[prompt - 2]?.trim(), 'with a blank row above it').toBe('');
        // The rail's notes are above that blank row, untouched.
        expect(open.slice(0, prompt - 2)).toEqual(closed.slice(0, prompt - 2));
      } finally {
        m.unmount();
      }
    });

    it('a two-row notice moves the prompt by the one row the second needs, and nothing else', async () => {
      const m = mountHome(variantOf(renderer));
      try {
        const { closed, open } = await withNotice(m, `${NOTICE}\nIt applies to new chats.`);
        expect(promptRow(open) - promptRow(closed)).toBe(1);
        expect(open[promptRow(open) - 1]?.trim()).toBe('It applies to new chats.');
        expect(open[promptRow(open) - 2]?.trim()).toBe(NOTICE);
        expect(open.length).toBeLessThanOrEqual(23);
      } finally {
        m.unmount();
      }
    });

    it('a long report still leaves the landing shorter than the terminal, with the prompt block and its hint', async () => {
      const m = mountHome(variantOf(renderer));
      try {
        const report = Array.from(
          { length: 40 },
          (_, index) => `report line ${String(index)}`,
        ).join('\n');
        const { open } = await withNotice(m, report);
        expect(open.length).toBeLessThanOrEqual(23);
        expect(hintRow(open)).toBeGreaterThan(promptRow(open));
        expect(open.some((row) => row.startsWith('      Notice 1–'))).toBe(true);
      } finally {
        m.unmount();
      }
    });
  },
);

describe('under the one-line title a one-row notice moves the prompt by one row (the title has no blank row to give)', () => {
  it('with `show_banner = false` the notice stands over the prompt and the hint follows the prompt', async () => {
    const m = mountHome(variantOf('alt'), { props: { showBanner: false } });
    try {
      const { closed, open } = await withNotice(m, NOTICE);
      expect(promptRow(open) - promptRow(closed)).toBe(1);
      expect(open[promptRow(open) - 1]?.trim()).toBe(NOTICE);
      expect(hintRow(open) - hintRow(closed)).toBe(1);
    } finally {
      m.unmount();
    }
  });
});
