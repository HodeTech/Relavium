/**
 * What the Home's two hint rows say at every width, and what gives way first (MVP-11 unit 7, round 2; `landingHint` and `workHint` in `home-pages.ts`).
 * Each ladder is the row from 10 columns up, run together where the row is the same: `[from, to, text]`, and the span drawn in the warning role
 * (`from-to`, `danger` when red) where there is one. Read down a ladder, the row at a narrower width is what the row above it gave up: the example
 * and the invitation first, the sessions and the runs, the others of Attention, the deadline's long form, the item's name down to six columns, and
 * never `[/] commands`, the `↓` or the exit; with a draft, `[Ctrl+J] newline` first. A shift of one column anywhere moves an entry.
 */
import { describe, expect, it } from 'vitest';

import type { EditorState } from './chat-input.js';
import {
  landingHint,
  workHint,
  type HintRow,
  type LandingHintState,
  type UrgentHead,
  type WorkCounts,
  type WorkHintState,
} from './home-pages.js';
import { HOSTED_RUN_ENTER_ITEM } from './home-projection.js';
import { displayWidth } from './viewport.js';

type Step = readonly [from: number, to: number, text: string, warn?: string];

/** The hint at every width from `from` to `to`, the widths that draw the same row (the same words, the same span) run together. */
function ladder(hint: (columns: number) => HintRow, from: number, to: number): readonly Step[] {
  const steps: [number, number, string, string?][] = [];
  const spanOf = (row: HintRow): string =>
    row.warn === undefined
      ? ''
      : `${String(row.warn.from)}-${String(row.warn.to)}${row.warn.tone === 'danger' ? ' danger' : ''}`;
  for (let columns = from; columns <= to; columns += 1) {
    const row = hint(columns);
    const span = spanOf(row);
    const last = steps.at(-1);
    if (last !== undefined && last[2] === row.text && (last[3] ?? '') === span) last[1] = columns;
    else
      steps.push(span === '' ? [columns, columns, row.text] : [columns, columns, row.text, span]);
  }
  return steps;
}

const editor = (text: string): EditorState => ({ text, cursor: text.length });
const NONE: WorkCounts = { attention: 0, sessions: 0, runs: 0 };
const COUNTS: WorkCounts = { attention: 3, sessions: 2, runs: 2 };
const AHEAD: UrgentHead = {
  name: 'release-notes',
  words: 'needs approval',
  deadline: 'expires in 5m',
  deadlineCompact: '5m left',
  overdue: false,
};

const landing =
  (over: Partial<LandingHintState>) =>
  (columns: number): HintRow =>
    landingHint(
      {
        interruptArmed: false,
        draft: editor(''),
        keyless: false,
        runCanBeShown: false,
        counts: NONE,
        columns,
        ...over,
      },
      displayWidth,
    );

const work =
  (over: Partial<WorkHintState>) =>
  (columns: number): HintRow =>
    workHint(
      {
        interruptArmed: false,
        row: undefined,
        draft: editor(''),
        keyless: false,
        runCanBeShown: false,
        hasRows: true,
        columns,
        ...over,
      },
      HOSTED_RUN_ENTER_ITEM,
      displayWidth,
    );

describe('the landing’s hint, width by width', () => {
  it('nothing to continue: the commands, the example, then the invitation', () => {
    expect(ladder(landing({}), 10, 120)).toEqual([
      [10, 58, '[/] commands · [Ctrl+C] exit (twice)'],
      [59, 83, '[/] commands · Tab fill the example · [Ctrl+C] exit (twice)'],
      [
        84,
        120,
        '[/] commands · type a message to chat · Tab fill the example · [Ctrl+C] exit (twice)',
      ],
    ]);
  });

  it('no key: `Enter connect a provider` first, and it stays at every width', () => {
    expect(ladder(landing({ keyless: true }), 10, 120)).toEqual([
      [10, 85, 'Enter connect a provider · [/] commands · [Ctrl+C] exit (twice)'],
      [
        86,
        120,
        'Enter connect a provider · [/] commands · Tab fill the example · [Ctrl+C] exit (twice)',
      ],
    ]);
  });

  it('something to continue and no item named: `↓ 3 need you`, then the sessions, then the runs, then the example', () => {
    expect(ladder(landing({ counts: COUNTS }), 10, 120)).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 72, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [
        73,
        95,
        '[/] commands · ↓ 3 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-27',
      ],
      [
        96,
        120,
        '[/] commands · ↓ 3 need you · 2 sessions · 2 runs · Tab fill the example · [Ctrl+C] exit (twice)',
        '15-27',
      ],
    ]);
  });

  it('sessions and runs and nothing under Attention: the `↓` stands on the first count', () => {
    expect(ladder(landing({ counts: { attention: 0, sessions: 2, runs: 2 } }), 10, 120)).toEqual([
      [10, 59, '[/] commands · ↓ 2 sessions · [Ctrl+C] exit (twice)'],
      [60, 82, '[/] commands · ↓ 2 sessions · 2 runs · [Ctrl+C] exit (twice)'],
      [
        83,
        120,
        '[/] commands · ↓ 2 sessions · 2 runs · Tab fill the example · [Ctrl+C] exit (twice)',
      ],
    ]);
  });

  it('no key and something to continue: the call to connect comes back last, when the counts all fit', () => {
    expect(ladder(landing({ keyless: true, counts: COUNTS }), 10, 120)).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 72, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [
        73,
        99,
        '[/] commands · ↓ 3 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-27',
      ],
      [
        100,
        120,
        'Enter connect a provider · [/] commands · ↓ 3 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '42-54',
      ],
    ]);
  });

  it('the most urgent item named, its deadline ahead', () => {
    expect(ladder(landing({ counts: COUNTS, urgent: AHEAD }), 10, 120)).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 71, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [72, 72, '[/] commands · ↓ relea… needs approval · 5m left · [Ctrl+C] exit (twice)', '15-48'],
      [
        73,
        73,
        '[/] commands · ↓ releas… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-49',
      ],
      [
        74,
        74,
        '[/] commands · ↓ release… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-50',
      ],
      [
        75,
        75,
        '[/] commands · ↓ release-… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-51',
      ],
      [
        76,
        76,
        '[/] commands · ↓ release-n… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-52',
      ],
      [
        77,
        77,
        '[/] commands · ↓ release-no… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-53',
      ],
      [
        78,
        78,
        '[/] commands · ↓ release-not… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-54',
      ],
      [
        79,
        84,
        '[/] commands · ↓ release-notes needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-55',
      ],
      [
        85,
        94,
        '[/] commands · ↓ release-notes needs approval · expires in 5m · [Ctrl+C] exit (twice)',
        '15-61',
      ],
      [
        95,
        103,
        '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more · [Ctrl+C] exit (twice)',
        '15-71',
      ],
      [
        104,
        116,
        '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
        '15-80',
      ],
      [
        117,
        120,
        '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · 2 sessions · [Ctrl+C] exit (twice)',
        '15-80',
      ],
    ]);
  });

  it('the most urgent item named, overdue: `expired` never gives way, and the warning is red', () => {
    expect(
      ladder(
        landing({
          counts: COUNTS,
          urgent: { ...AHEAD, deadline: 'expired', deadlineCompact: 'expired', overdue: true },
        }),
        10,
        120,
      ),
    ).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 71, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [
        72,
        72,
        '[/] commands · ↓ relea… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-48 danger',
      ],
      [
        73,
        73,
        '[/] commands · ↓ releas… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-49 danger',
      ],
      [
        74,
        74,
        '[/] commands · ↓ release… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-50 danger',
      ],
      [
        75,
        75,
        '[/] commands · ↓ release-… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-51 danger',
      ],
      [
        76,
        76,
        '[/] commands · ↓ release-n… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-52 danger',
      ],
      [
        77,
        77,
        '[/] commands · ↓ release-no… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-53 danger',
      ],
      [
        78,
        78,
        '[/] commands · ↓ release-not… needs approval · expired · [Ctrl+C] exit (twice)',
        '15-54 danger',
      ],
      [
        79,
        88,
        '[/] commands · ↓ release-notes needs approval · expired · [Ctrl+C] exit (twice)',
        '15-55 danger',
      ],
      [
        89,
        97,
        '[/] commands · ↓ release-notes needs approval · expired · +2 more · [Ctrl+C] exit (twice)',
        '15-65 danger',
      ],
      [
        98,
        110,
        '[/] commands · ↓ release-notes needs approval · expired · +2 more need you · [Ctrl+C] exit (twice)',
        '15-74 danger',
      ],
      [
        111,
        119,
        '[/] commands · ↓ release-notes needs approval · expired · +2 more need you · 2 sessions · [Ctrl+C] exit (twice)',
        '15-74 danger',
      ],
      [
        120,
        120,
        '[/] commands · ↓ release-notes needs approval · expired · +2 more need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-74 danger',
      ],
    ]);
  });

  it('the most urgent item named, with no deadline (a failed run)', () => {
    expect(
      ladder(
        landing({
          counts: COUNTS,
          urgent: { name: 'nightly', words: 'failed 2h ago', deadline: undefined, overdue: false },
        }),
        10,
        120,
      ),
    ).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 70, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [71, 71, '[/] commands · ↓ night… failed 2h ago · +2 more · [Ctrl+C] exit (twice)', '15-47'],
      [72, 80, '[/] commands · ↓ nightly failed 2h ago · +2 more · [Ctrl+C] exit (twice)', '15-48'],
      [
        81,
        93,
        '[/] commands · ↓ nightly failed 2h ago · +2 more need you · [Ctrl+C] exit (twice)',
        '15-57',
      ],
      [
        94,
        102,
        '[/] commands · ↓ nightly failed 2h ago · +2 more need you · 2 sessions · [Ctrl+C] exit (twice)',
        '15-57',
      ],
      [
        103,
        120,
        '[/] commands · ↓ nightly failed 2h ago · +2 more need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-57',
      ],
    ]);
  });

  it('the most urgent of those READ (more wait): the count of all leads, the item follows', () => {
    expect(
      ladder(
        landing({
          counts: { attention: 16, sessions: 2, runs: 2 },
          urgent: { ...AHEAD, partial: true },
        }),
        10,
        120,
      ),
    ).toEqual([
      [10, 64, '[/] commands · ↓ 16 need you · [Ctrl+C] exit (twice)', '15-28'],
      [65, 73, '[/] commands · ↓ 16 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-28'],
      [
        74,
        85,
        '[/] commands · ↓ 16 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-28',
      ],
      [
        86,
        86,
        '[/] commands · ↓ 16 need you · relea… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-62',
      ],
      [
        87,
        87,
        '[/] commands · ↓ 16 need you · releas… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-63',
      ],
      [
        88,
        88,
        '[/] commands · ↓ 16 need you · release… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-64',
      ],
      [
        89,
        89,
        '[/] commands · ↓ 16 need you · release-… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-65',
      ],
      [
        90,
        90,
        '[/] commands · ↓ 16 need you · release-n… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-66',
      ],
      [
        91,
        91,
        '[/] commands · ↓ 16 need you · release-no… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-67',
      ],
      [
        92,
        92,
        '[/] commands · ↓ 16 need you · release-not… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-68',
      ],
      [
        93,
        98,
        '[/] commands · ↓ 16 need you · release-notes needs approval · 5m left · [Ctrl+C] exit (twice)',
        '15-69',
      ],
      [
        99,
        111,
        '[/] commands · ↓ 16 need you · release-notes needs approval · expires in 5m · [Ctrl+C] exit (twice)',
        '15-75',
      ],
      [
        112,
        120,
        '[/] commands · ↓ 16 need you · release-notes needs approval · expires in 5m · 2 sessions · [Ctrl+C] exit (twice)',
        '15-75',
      ],
    ]);
  });

  it('a run that cannot be read has no name: its words are the head', () => {
    expect(
      ladder(
        landing({
          counts: { attention: 2, sessions: 0, runs: 0 },
          urgent: {
            name: undefined,
            words: 'a run cannot be read',
            deadline: undefined,
            overdue: false,
          },
        }),
        10,
        120,
      ),
    ).toEqual([
      [10, 70, '[/] commands · ↓ 2 need you · [Ctrl+C] exit (twice)', '15-27'],
      [71, 80, '[/] commands · ↓ a run cannot be read · +1 more · [Ctrl+C] exit (twice)', '15-47'],
      [
        81,
        103,
        '[/] commands · ↓ a run cannot be read · +1 more needs you · [Ctrl+C] exit (twice)',
        '15-57',
      ],
      [
        104,
        120,
        '[/] commands · ↓ a run cannot be read · +1 more needs you · Tab fill the example · [Ctrl+C] exit (twice)',
        '15-57',
      ],
    ]);
  });

  it('a draft: its own keys, then the cue, and `[Ctrl+J] newline` the first to give way', () => {
    expect(ladder(landing({ draft: editor('hi'), counts: COUNTS }), 10, 120)).toEqual([
      [10, 58, 'Enter start the chat · [Ctrl+C] exit (twice)'],
      [59, 77, 'Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)', '23-35'],
      [
        78,
        120,
        'Enter start the chat · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)',
        '42-54',
      ],
    ]);
  });

  it('a draft of one character is a draft', () => {
    expect(ladder(landing({ draft: editor('x'), counts: COUNTS }), 10, 120)).toEqual([
      [10, 58, 'Enter start the chat · [Ctrl+C] exit (twice)'],
      [59, 77, 'Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)', '23-35'],
      [
        78,
        120,
        'Enter start the chat · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)',
        '42-54',
      ],
    ]);
  });

  it('a draft of blanks is no draft: the hint of the empty prompt', () => {
    expect(ladder(landing({ draft: editor('   '), counts: COUNTS }), 10, 120)).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 72, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [
        73,
        120,
        '[/] commands · ↓ 3 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-27',
      ],
    ]);
  });

  it('a draft that starts with a slash runs a command', () => {
    expect(ladder(landing({ draft: editor('/help'), counts: COUNTS }), 10, 120)).toEqual([
      [10, 47, 'Enter run · [Ctrl+C] exit (twice)'],
      [48, 66, 'Enter run · ↓ 3 need you · [Ctrl+C] exit (twice)', '12-24'],
      [67, 120, 'Enter run · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)', '31-43'],
    ]);
  });

  it('blanks before the slash do not make it a message', () => {
    expect(ladder(landing({ draft: editor('  /help'), counts: COUNTS }), 10, 120)).toEqual([
      [10, 47, 'Enter run · [Ctrl+C] exit (twice)'],
      [48, 66, 'Enter run · ↓ 3 need you · [Ctrl+C] exit (twice)', '12-24'],
      [67, 120, 'Enter run · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)', '31-43'],
    ]);
  });

  it('no key and a draft: the message is kept, and that note gives way before the cue', () => {
    expect(
      ladder(landing({ draft: editor('hi'), keyless: true, counts: COUNTS }), 10, 120),
    ).toEqual([
      [10, 62, 'Enter connect a provider · [Ctrl+C] exit (twice)'],
      [63, 85, 'Enter connect a provider · ↓ 3 need you · [Ctrl+C] exit (twice)', '27-39'],
      [
        86,
        120,
        'Enter connect a provider · your message is kept · ↓ 3 need you · [Ctrl+C] exit (twice)',
        '50-62',
      ],
    ]);
  });

  it('a draft with the most urgent item named: the cue keeps its place and gives up its words in the head’s order', () => {
    expect(
      ladder(landing({ draft: editor('hi'), counts: COUNTS, urgent: AHEAD }), 10, 120),
    ).toEqual([
      [10, 58, 'Enter start the chat · [Ctrl+C] exit (twice)'],
      [59, 77, 'Enter start the chat · ↓ 3 need you · [Ctrl+C] exit (twice)', '23-35'],
      [
        78,
        79,
        'Enter start the chat · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)',
        '42-54',
      ],
      [
        80,
        80,
        'Enter start the chat · ↓ relea… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-56',
      ],
      [
        81,
        81,
        'Enter start the chat · ↓ releas… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-57',
      ],
      [
        82,
        82,
        'Enter start the chat · ↓ release… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-58',
      ],
      [
        83,
        83,
        'Enter start the chat · ↓ release-… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-59',
      ],
      [
        84,
        84,
        'Enter start the chat · ↓ release-n… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-60',
      ],
      [
        85,
        85,
        'Enter start the chat · ↓ release-no… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-61',
      ],
      [
        86,
        86,
        'Enter start the chat · ↓ release-not… needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-62',
      ],
      [
        87,
        92,
        'Enter start the chat · ↓ release-notes needs approval · 5m left · [Ctrl+C] exit (twice)',
        '23-63',
      ],
      [
        93,
        102,
        'Enter start the chat · ↓ release-notes needs approval · expires in 5m · [Ctrl+C] exit (twice)',
        '23-69',
      ],
      [
        103,
        111,
        'Enter start the chat · ↓ release-notes needs approval · expires in 5m · +2 more · [Ctrl+C] exit (twice)',
        '23-79',
      ],
      [
        112,
        120,
        'Enter start the chat · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
        '23-88',
      ],
    ]);
  });

  it('a run that can be shown: no call to connect first, whatever the key', () => {
    expect(
      ladder(landing({ keyless: true, runCanBeShown: true, counts: COUNTS }), 10, 120),
    ).toEqual([
      [10, 63, '[/] commands · ↓ 3 need you · [Ctrl+C] exit (twice)', '15-27'],
      [64, 72, '[/] commands · ↓ 3 need you · 2 sessions · [Ctrl+C] exit (twice)', '15-27'],
      [
        73,
        95,
        '[/] commands · ↓ 3 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
        '15-27',
      ],
      [
        96,
        120,
        '[/] commands · ↓ 3 need you · 2 sessions · 2 runs · Tab fill the example · [Ctrl+C] exit (twice)',
        '15-27',
      ],
    ]);
  });

  it('armed, it is only the second `Ctrl+C`, at every width', () => {
    expect(
      ladder(landing({ interruptArmed: true, counts: COUNTS, urgent: AHEAD }), 10, 120),
    ).toEqual([[10, 120, '[Ctrl+C] exit (again)']]);
  });
});

describe('the work page’s hint, width by width', () => {
  it('a session is focused', () => {
    expect(ladder(work({ row: { role: 'session' } }), 10, 90)).toEqual([
      [10, 64, '↑/↓ select session · Enter resume · Esc start page'],
      [65, 90, '↑/↓ select session · Enter resume · type to chat · Esc start page'],
    ]);
  });

  it('a failed run is focused', () => {
    expect(ladder(work({ row: { role: 'failed' } }), 10, 90)).toEqual([
      [10, 57, '↑/↓ select · Enter details · Esc start page'],
      [58, 90, '↑/↓ select · Enter details · type to chat · Esc start page'],
    ]);
  });

  it('a run that cannot be read is focused', () => {
    expect(ladder(work({ row: { role: 'unreadable' } }), 10, 90)).toEqual([
      [10, 53, '↑/↓ select · Enter why · Esc start page'],
      [54, 90, '↑/↓ select · Enter why · type to chat · Esc start page'],
    ]);
  });

  it('a parked run waiting at an approval is focused', () => {
    expect(ladder(work({ row: { role: 'parked', waits: 'approval' } }), 10, 90)).toEqual([
      [10, 54, '↑/↓ select · Enter open · Esc start page'],
      [55, 90, '↑/↓ select · Enter open · type to chat · Esc start page'],
    ]);
  });

  it('a parked run waiting for input is focused: its card shows how to answer', () => {
    expect(ladder(work({ row: { role: 'parked', waits: 'input' } }), 10, 90)).toEqual([
      [10, 68, '↑/↓ select · Enter show how to answer · Esc start page'],
      [69, 90, '↑/↓ select · Enter show how to answer · type to chat · Esc start page'],
    ]);
  });

  it('a parked run waiting for media is focused: `Enter` asks to continue it', () => {
    expect(ladder(work({ row: { role: 'parked', waits: 'media' } }), 10, 90)).toEqual([
      [10, 65, '↑/↓ select · Enter ask to continue · Esc start page'],
      [66, 90, '↑/↓ select · Enter ask to continue · type to chat · Esc start page'],
    ]);
  });

  it('a parked run with nothing to answer is focused: `Enter` says why', () => {
    expect(ladder(work({ row: { role: 'parked', waits: 'none' } }), 10, 90)).toEqual([
      [10, 57, '↑/↓ select · Enter say why · Esc start page'],
      [58, 90, '↑/↓ select · Enter say why · type to chat · Esc start page'],
    ]);
  });

  it('the docked prompt, nothing typed, a list to go back to', () => {
    expect(ladder(work({}), 10, 90)).toEqual([
      [10, 49, '[/] commands · Esc start page'],
      [50, 90, '[/] commands · ↑ back to the list · Esc start page'],
    ]);
  });

  it('the docked prompt, nothing typed, no list', () => {
    expect(ladder(work({ hasRows: false }), 10, 90)).toEqual([
      [10, 90, '[/] commands · Esc start page'],
    ]);
  });

  it('the docked prompt with no key', () => {
    expect(ladder(work({ keyless: true }), 10, 90)).toEqual([
      [10, 61, 'Enter connect a provider · Esc start page'],
      [62, 90, 'Enter connect a provider · ↑ back to the list · Esc start page'],
    ]);
  });

  it('the docked prompt with a run to show', () => {
    expect(ladder(work({ runCanBeShown: true }), 10, 90)).toEqual([
      [10, 50, 'Enter show it · Esc start page'],
      [51, 90, 'Enter show it · ↑ back to the list · Esc start page'],
    ]);
  });

  it('a draft in the docked prompt', () => {
    expect(ladder(work({ draft: editor('hi') }), 10, 90)).toEqual([
      [10, 57, 'Enter start the chat · Esc start page'],
      [58, 76, 'Enter start the chat · ↑ back to the list · Esc start page'],
      [77, 90, 'Enter start the chat · ↑ back to the list · [Ctrl+J] newline · Esc start page'],
    ]);
  });

  it('a draft of one character is a draft', () => {
    expect(ladder(work({ draft: editor('x') }), 10, 90)).toEqual([
      [10, 57, 'Enter start the chat · Esc start page'],
      [58, 76, 'Enter start the chat · ↑ back to the list · Esc start page'],
      [77, 90, 'Enter start the chat · ↑ back to the list · [Ctrl+J] newline · Esc start page'],
    ]);
  });

  it('a draft of blanks is no draft', () => {
    expect(ladder(work({ draft: editor('  ') }), 10, 90)).toEqual([
      [10, 49, '[/] commands · Esc start page'],
      [50, 90, '[/] commands · ↑ back to the list · Esc start page'],
    ]);
  });

  it('a draft that starts with a slash', () => {
    expect(ladder(work({ draft: editor('/run') }), 10, 90)).toEqual([
      [10, 46, 'Enter run · Esc start page'],
      [47, 65, 'Enter run · ↑ back to the list · Esc start page'],
      [66, 90, 'Enter run · ↑ back to the list · [Ctrl+J] newline · Esc start page'],
    ]);
  });

  it('blanks before the slash', () => {
    expect(ladder(work({ draft: editor('  /run') }), 10, 90)).toEqual([
      [10, 46, 'Enter run · Esc start page'],
      [47, 65, 'Enter run · ↑ back to the list · Esc start page'],
      [66, 90, 'Enter run · ↑ back to the list · [Ctrl+J] newline · Esc start page'],
    ]);
  });

  it('no key and a draft', () => {
    expect(ladder(work({ draft: editor('hi'), keyless: true }), 10, 90)).toEqual([
      [10, 84, 'Enter connect a provider · your message is kept · Esc start page'],
      [
        85,
        90,
        'Enter connect a provider · your message is kept · ↑ back to the list · Esc start page',
      ],
    ]);
  });

  it('a draft and no list to go back to', () => {
    expect(ladder(work({ draft: editor('hi'), hasRows: false }), 10, 90)).toEqual([
      [10, 55, 'Enter start the chat · Esc start page'],
      [56, 90, 'Enter start the chat · [Ctrl+J] newline · Esc start page'],
    ]);
  });

  it('a recent run and a parked run whose kind is not read yet say what a failed run and an approval say', () => {
    expect(ladder(work({ row: { role: 'recent' } }), 10, 90)).toEqual(
      ladder(work({ row: { role: 'failed' } }), 10, 90),
    );
    expect(ladder(work({ row: { role: 'parked', waits: undefined } }), 10, 90)).toEqual(
      ladder(work({ row: { role: 'parked', waits: 'approval' } }), 10, 90),
    );
  });

  it('armed, it is only the second `Ctrl+C`, at every width', () => {
    expect(ladder(work({ interruptArmed: true, row: { role: 'session' } }), 10, 90)).toEqual([
      [10, 90, '[Ctrl+C] exit (again)'],
    ]);
  });
});
