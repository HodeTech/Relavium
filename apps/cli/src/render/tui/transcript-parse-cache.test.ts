import { describe, expect, it, vi } from 'vitest';

import { parseMarkdown } from '../markdown/index.js';
import { chatGrid } from './chat-grid.js';
import { transcriptRows } from './chat-projection.js';

vi.mock('../markdown/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../markdown/index.js')>();
  return { ...actual, parseMarkdown: vi.fn(actual.parseMarkdown) };
});

/**
 * survivor P07: the parse of a reply is kept per entry so that a re-wrap at another width (a resize) lays the same blocks out again instead of
 * parsing the reply once more. Nothing pinned it: a build that never stored the parse passed every test.
 */
describe('the parsed markdown of a reply is kept across widths', () => {
  it('a reply is parsed once however many widths it is laid out at', () => {
    const entry = {
      role: 'assistant' as const,
      text: 'A **bold** reply with `code` and enough words to wrap at a narrow width.',
    };
    vi.mocked(parseMarkdown).mockClear();
    const a = transcriptRows([entry], chatGrid(80), true);
    const b = transcriptRows([entry], chatGrid(100), true);
    const c = transcriptRows([entry], chatGrid(40), true);
    expect(a.map((row) => row.text).join('')).toContain('bold reply');
    expect(b.length).toBeGreaterThan(0);
    expect(c.length).toBeGreaterThan(a.length - 1);
    expect(vi.mocked(parseMarkdown)).toHaveBeenCalledTimes(1);
  });
});
