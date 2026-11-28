import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import {
  chatEditorRows,
  MIN_TRANSCRIPT_ROWS,
  PROMPT_EDITOR_MAX_ROWS,
  promptEditorRows,
} from './chat-layout.js';
import { bracketed } from './harness-util.js';
import { PromptEditor } from './prompt-view.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * OB7-M3 (the observation of unit 7's chat half): a long draft clipped the cursor, the rule, the status line and the hint. A 30-line paste at 80×24
 * filled rows 4 to 23 with its first twenty lines; typing at the end was invisible, and the prompt editor had no height bound. The chat now gives its
 * editor a bound (`promptEditorRows`) and a draft that does not fit is drawn as a window of its rows around the cursor, with a `▲ N more` marker
 * (`^ N more` without colour) for those it hides. Tested through the real views of both hosts and both renderers; the editor's default (no bound) is
 * the output it always had, byte for byte.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
const RENDERERS = ['alt', 'inline'] as const;
const UP = '\u001b[A';
const DOWN = '\u001b[B';

const variant = (renderer: 'alt' | 'inline'): Variant => ({
  renderer,
  color: false,
  size: { cols: 80, rows: 24 },
});

/** The editor and the rows under it stand in the content column of the grid (unit 9): `GAP` columns from the left edge at 80 columns. */
const GAP = chatGrid(80).margin;

const LINES = Array.from({ length: 30 }, (_unused, index) => `draft line ${String(index + 1)}`);
const DRAFT = LINES.join('\n');

async function mountWithDraft(
  host: (typeof HOSTS)[number],
  renderer: 'alt' | 'inline',
): Promise<ChatMount> {
  const setup = {
    prepare: (store: ChatMount['store']) => store.appendUser('hello'),
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
  };
  const mount =
    host === 'chat'
      ? await mountHostedChat(variant(renderer), setup)
      : mountStandaloneChat(variant(renderer), setup);
  await mount.settle();
  mount.key(bracketed(DRAFT));
  await mount.until(() => mount.text().includes('draft line 30'));
  await mount.settle();
  return mount;
}

/** The rows of the prompt block: from the first draft row to the last row of the frame (rule, status, hint). */
function blockOf(mount: ChatMount): { readonly rows: string[]; readonly rule: number } {
  const rows = mount.frame();
  // the rule is the content column wide (68 at 80 columns), starting at the content column
  const rule = rows.findLastIndex((row) => new RegExp(`^ {${String(GAP)}}-{40,}$`, 'u').test(row));
  expect(rule, mount.text()).toBeGreaterThan(0);
  return { rows, rule };
}

/** The rows that hold a cell drawn inverse (the cursor block), by index. */
const cursorRows = (mount: ChatMount): number[] =>
  mount.cells().flatMap((row, index) => (row.some((cell) => cell.style.inverse) ? [index] : []));

describe.each(HOSTS)('a 30-line draft at 80×24, in the %s host', (host) => {
  describe.each(RENDERERS)('%s renderer', (renderer) => {
    it('keeps the cursor row, the rule, the status line and the hint on the screen', async () => {
      const m = await mountWithDraft(host, renderer);
      try {
        const { rows, rule } = blockOf(m);
        expect(rows.length, m.text()).toBeLessThanOrEqual(23);
        expect(rows[rule + 1], 'the status line is under the rule').toMatch(/ask mode/u);
        expect(rows[rule + 2], 'the hint row is under the status line').toMatch(/Enter send/u);
        expect(rows, 'the end of the draft is on screen').toContainEqual(
          expect.stringContaining('draft line 30'),
        );
        const cursor = cursorRows(m);
        expect(cursor, 'one cursor block, above the rule').toHaveLength(1);
        expect(cursor[0], m.text()).toBeLessThan(rule);
        expect(
          // the marker is set in under the prompt's glyph, inside the content column
          rows.some((row) => new RegExp(`^ {${String(GAP + 2)}}\\^ 2\\d more$`, 'u').test(row)),
          m.text(),
        ).toBe(true);
      } finally {
        m.unmount();
      }
    });

    it('shows what is typed at the end', async () => {
      const m = await mountWithDraft(host, renderer);
      try {
        m.key('ZZZ-END-MARKER');
        const shown = await m.until(() => m.text().includes('ZZZ-END-MARKER'));
        expect(shown, m.text()).toBe(true);
        const { rule } = blockOf(m);
        const at = m.frame().findIndex((row) => row.includes('ZZZ-END-MARKER'));
        expect(at).toBeLessThan(rule);
      } finally {
        m.unmount();
      }
    });

    it('follows the cursor up and down, always showing the row it is on', async () => {
      const m = await mountWithDraft(host, renderer);
      try {
        for (let step = 0; step < 25; step += 1) m.key(UP);
        await m.settle();
        const up = await m.until(() => m.text().includes('draft line 5'));
        expect(up, m.text()).toBe(true);
        expect(m.text(), 'the end of the draft has scrolled out of the window').not.toContain(
          'draft line 30',
        );
        expect(m.text()).toMatch(/v \d+ more/u);
        const cursor = cursorRows(m);
        expect(cursor).toHaveLength(1);
        for (let step = 0; step < 25; step += 1) m.key(DOWN);
        await m.settle();
        const down = await m.until(() => m.text().includes('draft line 30'));
        expect(down, m.text()).toBe(true);
        expect(cursorRows(m)).toHaveLength(1);
      } finally {
        m.unmount();
      }
    });

    it('still sends the WHOLE draft, not the window', async () => {
      const m = await mountWithDraft(host, renderer);
      try {
        m.key('\r');
        const sent = await m.until(() => m.submitted.length > 0);
        expect(sent, m.text()).toBe(true);
        expect(m.submitted[0]).toBe(DRAFT);
      } finally {
        m.unmount();
      }
    });
  });
});

describe('the bound the chat gives its editor', () => {
  it('is 8 rows at the supported 80×24 (a frame of 23 rows), leaving the transcript nine', () => {
    expect(promptEditorRows(23)).toBe(8);
    expect(23 - 2 - 4 - 8).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_ROWS);
  });

  it('shrinks with the frame so the transcript keeps its rows, and never goes under a window of three', () => {
    expect(promptEditorRows(15)).toBe(3);
    expect(promptEditorRows(17)).toBe(5);
    expect(promptEditorRows(8)).toBe(3);
    expect(promptEditorRows(1)).toBe(3);
  });

  it('never exceeds the most it takes of a tall terminal', () => {
    expect(promptEditorRows(200)).toBe(PROMPT_EDITOR_MAX_ROWS);
  });

  it('reads the full-screen frame’s rows first, else the inline renderer’s terminal (a frame one row short of it)', () => {
    expect(chatEditorRows(23, 24)).toBe(promptEditorRows(23));
    expect(chatEditorRows(23, undefined)).toBe(8);
    expect(chatEditorRows(undefined, 24)).toBe(promptEditorRows(23));
    expect(chatEditorRows(undefined, 18)).toBe(promptEditorRows(17));
    expect(chatEditorRows(undefined, undefined)).toBeUndefined();
  });

  it('leaves the editor unbounded for a host that does not know its height', () => {
    expect(promptEditorRows(undefined)).toBeUndefined();
    expect(promptEditorRows(Number.NaN)).toBeUndefined();
  });
});

describe('the editor without a bound is the editor it always was', () => {
  const frameOf = (props: Partial<Parameters<typeof PromptEditor>[0]>, text: string): string =>
    render(
      <PromptEditor editor={{ text, cursor: text.length }} color={false} {...props} />,
    ).lastFrame() ?? '';

  it('draws every row of a 30-line draft when given no bound, as before', () => {
    const rows = frameOf({}, DRAFT).split('\n');
    expect(rows).toHaveLength(30);
    expect(rows[0]).toMatch(/^> draft line 1/u);
  });

  it('draws a draft that fits its bound exactly as the unbounded editor does', () => {
    const small = LINES.slice(0, 5).join('\n');
    const unbounded = frameOf({}, small);
    expect(frameOf({ maxRows: 5, columns: 80 }, small)).toBe(unbounded);
    expect(frameOf({ maxRows: 50, columns: 80 }, small)).toBe(unbounded);
    expect(frameOf({ maxRows: 8, columns: 80 }, '')).toBe(frameOf({}, ''));
  });

  it('windows a draft that does not fit, in at most the bound', () => {
    const rows = frameOf({ maxRows: 8, columns: 80 }, DRAFT).split('\n');
    expect(rows).toHaveLength(8);
  });
});
