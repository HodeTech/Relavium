import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { MODE_DESCRIPTION } from '../../chat/chat-mode.js';
import { waitFor, withoutStyles } from './harness-util.js';
import { withGlyphForm } from './glyphs.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { selectRowLines } from './native-select-window.js';

afterEach(cleanup);

/**
 * The rows of a select card whose option hints are long (the `/mode` startup default: `accept-edits` and `auto` say a whole sentence of effect) at
 * `cols` columns. A row that wraps hangs under its label: its later rows start where the label starts, never at the left edge of the terminal.
 */
async function modeCard(cols: number, rows = 24) {
  const { ui, flow } = createNativePromptChannel();
  flow.begin();
  void flow.select({
    message: 'Choose a global startup default. Selection alone saves nothing.',
    options: (['ask', 'plan', 'accept-edits', 'auto'] as const).map((value) => ({
      value,
      label: value,
      hint: MODE_DESCRIPTION[value],
    })),
    escape: 'cancel',
  });
  const h = render(<NativePromptHost ui={ui} color={false} />);
  Object.defineProperty(h.stdout, 'columns', { value: cols });
  Object.defineProperty(h.stdout, 'rows', { value: rows });
  h.stdout.emit('resize');
  await waitFor(() => withoutStyles(h.lastFrame() ?? '').includes('accept-edits'));
  const lines = (): string[] => withoutStyles(h.lastFrame() ?? '').split('\n');
  const visible = (): boolean => {
    try {
      ui.assertVisible(ui.getSnapshot());
      return true;
    } catch {
      return false;
    }
  };
  return { lines, visible, ui };
}

describe('the rows of a select card that wrap hang under their label', () => {
  it.each([80])(
    'at %i columns (the floor) every row after the first of an option starts under its label, and no row is wider than the terminal',
    async (cols) => {
      const card = await modeCard(cols);
      const lines = card.lines();
      const first = lines.findIndex((line) => line.startsWith('> ask'));
      const legendAt = lines.findIndex((line) => line.includes('Enter choose'));
      expect(first, lines.join('\n')).toBeGreaterThan(0);
      const body = lines.slice(first, legendAt);
      const starts = body.filter((line) => /^(> | {2})(ask|plan|accept-edits|auto) — /u.test(line));
      const continuations = body.filter((line) => !starts.includes(line));
      for (const line of body) expect(line.length, line).toBeLessThanOrEqual(cols);
      expect(starts, body.join('\n')).toHaveLength(4);
      // the long hints wrap at the floor: without a wrapped row the property would be vacuous
      expect(continuations.length, body.join('\n')).toBeGreaterThan(0);
      // each later row of an option starts under its label: the two columns of the cursor's gutter, then a word
      for (const line of continuations)
        expect(line, 'a later row hangs under the label').toMatch(/^ {2}\S/u);
      await waitFor(card.visible, 40);
    },
  );

  it('draws exactly the rows `selectRowLines` says, so the card’s own estimate of its height is the height it has', async () => {
    const card = await modeCard(80);
    const lines = card.lines();
    const snapshot = card.ui.getSnapshot();
    const expected = snapshot.options.flatMap((_, index) =>
      withGlyphForm(true, () => selectRowLines(snapshot, index, 80)),
    );
    const first = lines.findIndex((line) => line.startsWith('> ask'));
    expect(lines.slice(first, first + expected.length)).toEqual(expected);
  });

  it('hangs a long row under its label at any width, never wider than the row, and loses no word', () => {
    const { ui, flow } = createNativePromptChannel();
    flow.begin();
    void flow.select({
      message: 'q',
      options: [
        {
          value: 'a',
          label: 'label',
          hint: 'one two three four five six seven eight nine ten '.repeat(6),
        },
        { value: 'b', label: 'x'.repeat(130) },
      ],
      escape: 'cancel',
    });
    const snapshot = ui.getSnapshot();
    for (const columns of [80, 81, 100, 120]) {
      for (const index of [0, 1]) {
        const rows = withGlyphForm(true, () => selectRowLines(snapshot, index, columns));
        expect(rows.length).toBeGreaterThan(1);
        for (const row of rows) expect(row.length, row).toBeLessThanOrEqual(columns);
        for (const row of rows.slice(1)) expect(row, 'hangs under the label').toMatch(/^ {2}\S/u);
        const words = (text: string): string => text.replaceAll(/\s+/gu, '');
        const drawn = words(rows.map((row) => row.slice(2)).join(''));
        const said = words(
          withGlyphForm(true, () => selectRowLines(snapshot, index, 100_000))
            .join('')
            .slice(2),
        );
        expect(drawn, `${columns} columns, option ${index}`).toBe(said);
      }
    }
    ui.getSnapshot();
  });

  it('keeps the cursor row the first row of its option and the legend under the last', async () => {
    const card = await modeCard(80);
    const lines = card.lines();
    expect(lines[1]).toMatch(/^> ask — /u);
    expect(lines.at(-1)).toContain('Esc close');
  });
});
