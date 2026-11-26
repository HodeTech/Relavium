/**
 * Page 1's most urgent item and the work page's `Enter` per kind, as pure data (MVP-11 unit 7, the maintainer's rulings 4 and 5): the landing's
 * head names the item, and what a narrow row gives up is, in order (round 2: the deadline outranks the count of the others), the session and
 * run counts, the long form of `+N more need you`, the others whole, the deadline's long form for its compact one (`5m left`), then the name's
 * columns around the compact deadline; when the name cannot keep {@link URGENT_NAME_FLOOR} columns the head says the count of all of Attention.
 * An overdue item never gives up `expired`. `home-pages-urgent-ladder.test.ts` walks the whole ladder over every width and shape. The work
 * page's hint names the focused row's `Enter` and gives up `type to chat` first.
 */
import { describe, expect, it } from 'vitest';

import type { EditorState } from './chat-input.js';
import {
  landingHint,
  URGENT_NAME_FLOOR,
  workHint,
  type HintRow,
  type UrgentHead,
  type WorkCounts,
} from './home-pages.js';
import { displayWidth } from './viewport.js';

const EMPTY: EditorState = { text: '', cursor: 0 };
const DRAFT: EditorState = { text: 'hello', cursor: 5 };
const URGENT: UrgentHead = {
  name: 'release-notes',
  words: 'needs approval',
  deadline: 'expires in 5m',
  deadlineCompact: '5m left',
  overdue: false,
};
const COUNTS: WorkCounts = { attention: 3, sessions: 4, runs: 5 };

const landing = (over: {
  urgent?: UrgentHead;
  counts?: WorkCounts;
  draft?: EditorState;
  columns: number;
  keyless?: boolean;
}): HintRow =>
  landingHint(
    {
      interruptArmed: false,
      draft: over.draft ?? EMPTY,
      keyless: over.keyless === true,
      runCanBeShown: false,
      counts: over.counts ?? COUNTS,
      urgent: over.urgent ?? URGENT,
      columns: over.columns,
    },
    displayWidth,
  );

const warned = (row: HintRow): string | undefined =>
  row.warn === undefined ? undefined : row.text.slice(row.warn.from, row.warn.to);

describe('the landing names the most urgent item', () => {
  it('with room: the head, its deadline, the others, the true counts, the example, the exit', () => {
    const row = landing({ columns: 200 });
    expect(row.text).toBe(
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · 4 sessions · 5 runs · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(warned(row)).toBe('↓ release-notes needs approval · expires in 5m · +2 more need you');
    expect(row.warn?.tone).toBeUndefined();
  });

  it('gives up, as the row narrows: the example, the runs, the sessions, `need you`, the others, the deadline’s long form, then the name, column by column', () => {
    const widths = [140, 126, 117, 104, 100, 88, 79, 74, 69];
    const rows = widths.map((columns) => landing({ columns }).text);
    expect(rows).toEqual([
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · 4 sessions · 5 runs · [Ctrl+C] exit (twice)',
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · 4 sessions · 5 runs · [Ctrl+C] exit (twice)',
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · 4 sessions · [Ctrl+C] exit (twice)',
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more · [Ctrl+C] exit (twice)',
      // the maintainer's own example, whole, once the others no longer fit beside it (85 columns)
      '[/] commands · ↓ release-notes needs approval · expires in 5m · [Ctrl+C] exit (twice)',
      '[/] commands · ↓ release-notes needs approval · 5m left · [Ctrl+C] exit (twice)',
      // the name is cut around the compact deadline, which outranks the others
      '[/] commands · ↓ release… needs approval · 5m left · [Ctrl+C] exit (twice)',
      // below the name's floor the head is the count indicator, as it was before it could name an item (its counts droppable as ever)
      '[/] commands · ↓ 3 need you · 4 sessions · [Ctrl+C] exit (twice)',
    ]);
    for (const [index, columns] of widths.entries())
      expect(displayWidth(rows[index] ?? ''), String(columns)).toBeLessThanOrEqual(columns);
  }); // prettier-ignore

  it('keeps the name to its floor and no shorter: below it the head says the true count instead', () => {
    // `↓ ` + floor + ` needs approval` and the compact deadline beside the hint's own items
    const floorRow = '[/] commands · ↓ relea… needs approval · 5m left · [Ctrl+C] exit (twice)';
    expect(displayWidth('relea…')).toBe(URGENT_NAME_FLOOR);
    expect(landing({ columns: displayWidth(floorRow) }).text).toBe(floorRow);
    expect(landing({ columns: displayWidth(floorRow) - 1 }).text).toBe(
      '[/] commands · ↓ 3 need you · 4 sessions · [Ctrl+C] exit (twice)',
    );
    expect(warned(landing({ columns: displayWidth(floorRow) - 1 }))).toBe('↓ 3 need you');
  });

  it('with one item there is no `+N more`; the count of Attention is the snapshot’s, not the rows loaded', () => {
    expect(landing({ columns: 200, counts: { attention: 1, sessions: 0, runs: 0 } }).text).toBe(
      '[/] commands · ↓ release-notes needs approval · expires in 5m · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(landing({ columns: 200, counts: { attention: 40, sessions: 0, runs: 0 } }).text).toContain(
      '+39 more need you',
    );
    expect(landing({ columns: 200, counts: { attention: 2, sessions: 0, runs: 0 } }).text).toContain(
      '+1 more needs you',
    );
  }); // prettier-ignore

  it('an overdue item: the span’s tone is danger (red)', () => {
    const row = landing({
      columns: 200,
      urgent: { ...URGENT, deadline: 'expired', overdue: true },
    });
    expect(row.warn?.tone).toBe('danger');
    expect(warned(row)).toBe('↓ release-notes needs approval · expired · +2 more need you');
  });

  it('a run that cannot be read is named by its words alone', () => {
    const row = landing({
      columns: 200,
      urgent: {
        name: undefined,
        words: 'a run cannot be read',
        deadline: undefined,
        overdue: false,
      },
    });
    expect(warned(row)).toBe('↓ a run cannot be read · +2 more need you');
  });

  it('with a draft: `[Ctrl+J] newline` gives way first, then the head shrinks as above, then it says the count, and only then does it go', () => {
    const at = (columns: number): string => landing({ columns, draft: DRAFT }).text;
    expect(at(200)).toBe(
      'Enter start the chat · [Ctrl+J] newline · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
    );
    expect(at(112)).toBe(
      'Enter start the chat · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
    );
    // 80: the name keeps exactly its floor; 74: below it, the count
    expect(at(80)).toBe('Enter start the chat · ↓ relea… needs approval · 5m left · [Ctrl+C] exit (twice)');
    expect(at(74)).toBe('Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)');
    expect(at(60)).toBe('Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)');
    expect(at(40)).toBe('Enter start the chat · [Ctrl+C] exit (twice)');
  }); // prettier-ignore

  it('with no key the call to connect gives way before any part of the head', () => {
    expect(landing({ columns: 140, keyless: true }).text).toBe(
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · 4 sessions · 5 runs · [Ctrl+C] exit (twice)',
    );
    expect(landing({ columns: 200, keyless: true }).text.startsWith('Enter connect a provider · ')).toBe(true);
  }); // prettier-ignore
});

describe('the work page’s hint names the focused row’s `Enter`', () => {
  const work = (columns: number) =>
    workHint(
      {
        interruptArmed: false,
        row: { role: 'parked', waits: 'input' },
        draft: EMPTY,
        keyless: false,
        runCanBeShown: false,
        hasRows: true,
        columns,
      },
      { keys: 'Enter', verb: 'show it' },
      displayWidth,
    ).text;

  it('fits 80 columns whole, and gives up `type to chat` first: the arrows, the `Enter` and the way back never', () => {
    expect(work(74)).toBe('↑/↓ select · Enter show how to answer · type to chat · Esc start page');
    expect(work(60)).toBe('↑/↓ select · Enter show how to answer · Esc start page');
    expect(work(30)).toBe('↑/↓ select · Enter show how to answer · Esc start page');
  });
});
