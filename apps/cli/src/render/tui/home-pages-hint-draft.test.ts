/**
 * The two pages' hint rows with a draft (MVP-11 unit 7, round 1): a draft of nothing but spaces is no draft (CO77: `Space` on a focused row moves
 * to the docked prompt with a blank draft, and `Enter` there does what it does on an empty prompt, so the hint must not promise `Enter start the
 * chat`); and with a real draft on the landing at 80 columns the `↓ N need you` cue stays and `[Ctrl+J] newline` gives way first (OB73: the cue is
 * the landing's one sign of a gate that waits, and it vanished while the person typed). What is SENT for a real draft is not the hint's business
 * and does not change. Pure: `home-pages.test.ts` owns the rest of the hints.
 */
import { describe, expect, it } from 'vitest';

import type { EditorState } from './chat-input.js';
import { landingHint, workHint, type WorkCounts } from './home-pages.js';
import { HOSTED_RUN_ENTER_ITEM } from './home-projection.js';
import { displayWidth } from './viewport.js';

const editor = (text: string): EditorState => ({ text, cursor: text.length });
const EMPTY = editor('');
const BLANKS = [editor(' '), editor('   '), editor('\t'), editor(' \n ')] as const;
/** The Home at 80 columns: 74 for the hint after the margin. */
const AT_80 = 74;
const NONE: WorkCounts = { attention: 0, sessions: 0, runs: 0 };
const THREE: WorkCounts = { attention: 3, sessions: 2, runs: 2 };

const landing = (draft: EditorState, counts: WorkCounts, columns = AT_80) =>
  landingHint(
    { interruptArmed: false, draft, keyless: false, runCanBeShown: false, counts, columns },
    displayWidth,
  );
const docked = (draft: EditorState, columns = AT_80) =>
  workHint(
    {
      interruptArmed: false,
      row: undefined,
      draft,
      keyless: false,
      runCanBeShown: false,
      hasRows: true,
      columns,
    },
    HOSTED_RUN_ENTER_ITEM,
    displayWidth,
  ).text;

describe('a draft of nothing but spaces is no draft for the hint (CO77)', () => {
  it.each(BLANKS.map((blank) => [JSON.stringify(blank.text), blank] as const))(
    'the docked prompt with %s says what `Enter` does on an empty prompt, never `Enter start the chat`',
    (_name, blank) => {
      expect(docked(blank)).toBe(docked(EMPTY));
      expect(docked(blank)).not.toContain('start the chat');
    },
  );

  it.each(BLANKS.map((blank) => [JSON.stringify(blank.text), blank] as const))(
    'the landing with %s says the empty prompt’s keys, less the example `Tab` fills only into an empty prompt',
    (_name, blank) => {
      for (const counts of [NONE, THREE]) {
        const text = landing(blank, counts, 200).text;
        expect(text).not.toContain('start the chat');
        expect(text, 'the example is not on screen behind a blank draft').not.toContain(
          'fill the example',
        );
        expect(text.replace(/ · Tab fill the example/u, '')).toBe(
          landing(EMPTY, counts, 200).text.replace(/ · Tab fill the example/u, ''),
        );
      }
    },
  );

  it('a real draft keeps its own words, a leading space or not', () => {
    expect(docked(editor(' fix it'))).toBe(
      'Enter start the chat · ↑ back to the list · Esc start page',
    );
    expect(landing(editor(' fix it'), NONE).text).toContain('Enter start the chat');
  });
});

describe('with a draft on the landing at 80 columns the `↓ N need you` cue stays (OB73)', () => {
  it('`[Ctrl+J] newline` gives way before the cue: `Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)`', () => {
    const row = landing(editor('fix the flaky test'), THREE);
    expect(row.text).toBe('Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)');
    expect(displayWidth(row.text)).toBeLessThanOrEqual(AT_80);
    expect(row.warn && row.text.slice(row.warn.from, row.warn.to), 'in the warning role').toBe(
      '↓ 3 need you',
    );
  });

  it('with the room for all of it, `[Ctrl+J] newline` stays, before the cue', () => {
    expect(landing(editor('fix the flaky test'), THREE, 120).text).toBe(
      'Enter start the chat · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)',
    );
  });

  it('a slash line keeps `[Ctrl+J] newline` and the cue at 80 columns, where both fit', () => {
    expect(landing(editor('/mod'), THREE).text).toBe(
      'Enter run · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)',
    );
  });
});
