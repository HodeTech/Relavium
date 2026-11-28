/**
 * The landing's hint with a named item, over every width and shape (MVP-11 unit 7, round 2: observation F3, correctness F1 and F7). The rules
 * the ladder keeps, each walked over the widths 74 to 200 and a spread of the item kinds, the counts, the drafts, the key state and the hosted
 * run, with the work done by the real `landingHint`:
 *
 * - no row is wider than its columns, and the exit key is always last;
 * - the warning span starts at the `↓`, ends at an item's end, and is red exactly when the item is overdue;
 * - `+N more` is always true (N is the others of Attention), and an overdue item keeps the word `expired` whenever it is named;
 * - the maintainer's own example (`↓ release-notes needs approval · expires in 5m`) is on the row wherever it fits, and the deadline's compact
 *   form only where it does not;
 * - an item that is only the most urgent of those READ never leads the head: the count of everything does, with no `+N more`;
 * - with a draft and no key the `↓ N need you` cue is on the row from the width its own items need (it was gone below 86 columns).
 *
 * `home-pages-urgent.test.ts` pins the exact rows at chosen widths.
 */
import { describe, expect, it } from 'vitest';

import type { EditorState } from './chat-input.js';
import { landingHint, needsYouWords, type HintRow, type UrgentHead } from './home-pages.js';
import { displayWidth } from './viewport.js';
import { yieldBetweenTests } from '../event-loop.test-support.js';

// this file's tests run for seconds back to back: the event loop turns between them (`../event-loop.test-support.ts`)
yieldBetweenTests();

/** The walk is a few thousand real hint fits per test: a bound that holds on a loaded machine too. */
const SLOW_MS = 30_000;
const EXIT = '[Ctrl+C] exit (twice)';
const COLUMNS = Array.from({ length: 127 }, (_, index) => 74 + index);

const AHEAD: UrgentHead = {
  name: 'release-notes',
  words: 'needs approval',
  deadline: 'expires in 5m',
  deadlineCompact: '5m left',
  overdue: false,
};
const KINDS: Readonly<Record<string, UrgentHead>> = {
  ahead: AHEAD,
  'ahead, hours, a long name': {
    name: 'nightly-compliance-report-x',
    words: 'needs input',
    deadline: 'expires in 1h',
    deadlineCompact: '1h left',
    overdue: false,
  },
  overdue: {
    name: 'deploy-check',
    words: 'needs approval',
    deadline: 'expired',
    deadlineCompact: 'expired',
    overdue: true,
  },
  failed: {
    name: 'nightly',
    words: 'failed 2h ago',
    deadline: undefined,
    overdue: false,
  },
  unreadable: {
    name: undefined,
    words: 'a run cannot be read',
    deadline: undefined,
    overdue: false,
  },
  'partial, ahead': { ...AHEAD, partial: true },
  'partial, overdue': {
    name: 'deploy-check',
    words: 'needs approval',
    deadline: 'expired',
    deadlineCompact: 'expired',
    overdue: true,
    partial: true,
  },
  'partial, failed': {
    name: 'nightly',
    words: 'failed 2h ago',
    deadline: undefined,
    overdue: false,
    partial: true,
  },
};
const ATTENTION = [1, 3, 120] as const;
const LISTS = [
  { sessions: 0, runs: 0 },
  { sessions: 4, runs: 5 },
] as const;
const DRAFTS: readonly EditorState[] = [
  { text: '', cursor: 0 },
  { text: 'hello', cursor: 5 },
  { text: '/mod', cursor: 4 },
];

interface Case {
  readonly label: string;
  readonly urgent: UrgentHead;
  readonly attention: number;
  readonly sessions: number;
  readonly runs: number;
  readonly draft: EditorState;
  readonly keyless: boolean;
  readonly hosted: boolean;
}

/** Every combination of the dimensions, every `STRIDE`-th of them: the stride is coprime to the sizes, so each dimension is covered evenly. */
const STRIDE = 5;
const CASES: readonly Case[] = (() => {
  const all: Case[] = [];
  for (const [label, urgent] of Object.entries(KINDS))
    for (const attention of ATTENTION)
      for (const list of LISTS)
        for (const draft of DRAFTS)
          for (const keyless of [false, true])
            for (const hosted of [false, true])
              all.push({ label, urgent, attention, ...list, draft, keyless, hosted });
  return all.filter((_, index) => index % STRIDE === 0);
})();

const hint = (c: Case, columns: number): HintRow =>
  landingHint(
    {
      interruptArmed: false,
      draft: c.draft,
      keyless: c.keyless,
      runCanBeShown: c.hosted,
      counts: { attention: c.attention, sessions: c.sessions, runs: c.runs },
      urgent: c.urgent,
      columns,
    },
    displayWidth,
  );

const describeCase = (c: Case, columns: number): string =>
  `${c.label}, ${String(c.attention)} need you, ${String(c.sessions)}/${String(c.runs)}, draft ${JSON.stringify(c.draft.text)}, ${c.keyless ? 'keyless' : 'keyed'}, ${c.hosted ? 'hosted' : 'idle'}, ${String(columns)} columns`;

describe('the named head, over every width and shape', () => {
  it('covers a spread of at least 100 shapes (the stride must not thin it out)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
    for (const label of Object.keys(KINDS))
      expect(
        CASES.some((c) => c.label === label),
        label,
      ).toBe(true);
  });

  it(
    'never overflows its columns, and the exit key is always last',
    () => {
      for (const c of CASES)
        for (const columns of COLUMNS) {
          const row = hint(c, columns);
          const where = describeCase(c, columns);
          expect(displayWidth(row.text), where).toBeLessThanOrEqual(columns);
          expect(row.text.endsWith(EXIT), where).toBe(true);
        }
    },
    SLOW_MS,
  );

  it(
    'the warning span starts at the `↓`, ends at an item’s end, and is red exactly when the named item is overdue',
    () => {
      for (const c of CASES)
        for (const columns of COLUMNS) {
          const row = hint(c, columns);
          const where = describeCase(c, columns);
          if (row.warn === undefined) continue;
          const { from, to } = row.warn;
          const span = row.text.slice(from, to);
          expect(span.startsWith('↓'), where).toBe(true);
          expect(span, where).not.toContain('[Ctrl+C]');
          expect(from === 0 || row.text.slice(from - 3, from) === ' · ', where).toBe(true);
          expect(to === row.text.length || row.text.slice(to, to + 3) === ' · ', where).toBe(true);
          const named = c.urgent.name !== undefined && span.includes(c.urgent.words);
          const tone = row.warn.tone;
          expect(tone, where).toBe(named && c.urgent.overdue ? 'danger' : undefined);
        }
    },
    SLOW_MS,
  );

  it(
    '`+N more` is the others of Attention, whatever the width; the partial shape has none, and says the count of all',
    () => {
      for (const c of CASES)
        for (const columns of COLUMNS) {
          const text = hint(c, columns).text;
          const where = describeCase(c, columns);
          const more = /\+(\d+) more/u.exec(text);
          const named = text.includes(c.urgent.words);
          if (c.urgent.partial === true) {
            expect(more, where).toBeNull();
            if (named) expect(text, where).toContain(`↓ ${needsYouWords(c.attention)} · `);
          } else if (more !== null) {
            expect(Number(more[1]), where).toBe(c.attention - 1);
          }
          expect(text.split('↓').length - 1, where).toBeLessThanOrEqual(1);
        }
    },
    SLOW_MS,
  );

  it(
    'an overdue item keeps `expired` whenever it is named, at every width',
    () => {
      for (const c of CASES)
        for (const columns of COLUMNS) {
          if (!c.urgent.overdue) continue;
          const text = hint(c, columns).text;
          if (text.includes(c.urgent.words))
            expect(text, describeCase(c, columns)).toContain('expired');
        }
    },
    SLOW_MS,
  );

  it(
    'the deadline is never both long and compact on one row, and the compact one stands only without the others',
    () => {
      for (const c of CASES)
        for (const columns of COLUMNS) {
          const text = hint(c, columns).text;
          const where = describeCase(c, columns);
          const long = c.urgent.deadline !== undefined && text.includes(c.urgent.deadline);
          const compact =
            c.urgent.deadlineCompact !== undefined &&
            c.urgent.deadlineCompact !== c.urgent.deadline &&
            text.includes(c.urgent.deadlineCompact);
          expect(long && compact, where).toBe(false);
          if (compact && c.urgent.partial !== true) expect(text, where).not.toMatch(/\+\d+ more/u);
        }
    },
    SLOW_MS,
  );
});

describe('the maintainer’s own example, wherever it fits', () => {
  const EXAMPLE = '↓ release-notes needs approval · expires in 5m';
  const EMPTY: EditorState = { text: '', cursor: 0 };
  const at = (columns: number, urgent: UrgentHead = AHEAD, attention = 3): string =>
    hint(
      {
        label: 'example',
        urgent,
        attention,
        sessions: 4,
        runs: 5,
        draft: EMPTY,
        keyless: false,
        hosted: false,
      },
      columns,
    ).text;

  it('is on the row from the width it needs (the whole row is 85 columns) and at every width above it', () => {
    const row = `[/] commands · ${EXAMPLE} · ${EXIT}`;
    expect(displayWidth(row)).toBe(85);
    for (const columns of COLUMNS) {
      const text = at(columns);
      if (columns >= 85) expect(text, String(columns)).toContain(EXAMPLE);
      else expect(text, String(columns)).not.toContain(EXAMPLE);
    }
  });

  it('is followed by the others as soon as they fit beside it (95 columns), and by the counts as soon as they do', () => {
    expect(at(94)).toBe(`[/] commands · ${EXAMPLE} · ${EXIT}`);
    expect(at(95)).toBe(`[/] commands · ${EXAMPLE} · +2 more · ${EXIT}`);
    expect(at(104)).toBe(`[/] commands · ${EXAMPLE} · +2 more need you · ${EXIT}`);
  });

  it('in a row too narrow for it the deadline is the compact form, and the name is cut around it only after that', () => {
    expect(at(84)).toBe(`[/] commands · ↓ release-notes needs approval · 5m left · ${EXIT}`);
    expect(at(78)).toBe(`[/] commands · ↓ release-not… needs approval · 5m left · ${EXIT}`);
  });

  it('an item with no deadline keeps `+N more` through the cut name, as it always has', () => {
    const failed = KINDS['failed'] ?? AHEAD;
    expect(at(88, failed)).toBe(
      `[/] commands · ↓ nightly failed 2h ago · +2 more need you · ${EXIT}`,
    );
    expect(at(40, failed)).toContain('↓ 3 need you');
  });
});

describe('the report’s two rows', () => {
  const draft: EditorState = { text: 'fix the flaky test', cursor: 18 };
  const hintOf = (urgent: UrgentHead, attention: number, columns: number, text = ''): string =>
    landingHint(
      {
        interruptArmed: false,
        draft: text === '' ? { text: '', cursor: 0 } : { text, cursor: text.length },
        keyless: false,
        runCanBeShown: false,
        counts: { attention, sessions: 0, runs: 0 },
        urgent,
        columns,
      },
      displayWidth,
    ).text;

  it('at 100 columns an overdue gate says `expired` and the others: `↓ deploy-check needs approval · expired · +9 more`', () => {
    const overdue = KINDS['overdue'] ?? AHEAD;
    const text = hintOf(overdue, 10, 100, draft.text);
    expect(text).toContain('↓ deploy-check needs approval · expired · +9 more');
    expect(text).toBe(
      'Enter start the chat · ↓ deploy-check needs approval · expired · +9 more · [Ctrl+C] exit (twice)',
    );
    expect(displayWidth(text)).toBe(96);
  });

  it('at 80 columns a gate that is not overdue says `↓ triage-bugs needs input · 1h left`', () => {
    const urgent: UrgentHead = {
      name: 'triage-bugs',
      words: 'needs input',
      deadline: 'expires in 1h',
      deadlineCompact: '1h left',
      overdue: false,
    };
    // 74 columns for the hint after the margin of an 80-column terminal
    const text = hintOf(urgent, 12, 74);
    expect(text).toContain('↓ triage-bugs needs input · 1h left');
    expect(text).not.toContain('+11 more');
  });
});

describe('an item that is only the most urgent of those read does not lead the head (correctness F1)', () => {
  it('leads with the count of everything that needs the person and names the item after it', () => {
    const partial: UrgentHead = { ...AHEAD, partial: true };
    const text = landingHint(
      {
        interruptArmed: false,
        draft: { text: '', cursor: 0 },
        keyless: false,
        runCanBeShown: false,
        counts: { attention: 16, sessions: 0, runs: 0 },
        urgent: partial,
        columns: 120,
      },
      displayWidth,
    ).text;
    expect(text).toBe(
      `[/] commands · ↓ 16 need you · release-notes needs approval · expires in 5m · ${EXIT}`,
    );
  });
});

describe('with a draft and no key the `↓ N need you` cue stays at 80 columns (correctness F7)', () => {
  const keyless = (columns: number, attention = 3, text = 'hello'): string =>
    landingHint(
      {
        interruptArmed: false,
        draft: { text, cursor: text.length },
        keyless: true,
        runCanBeShown: false,
        counts: { attention, sessions: 0, runs: 0 },
        columns,
      },
      displayWidth,
    ).text;

  it('`your message is kept` gives way before the cue does: the row at 74 columns', () => {
    expect(keyless(74)).toBe('Enter connect a provider · ↓ 3 need you · [Ctrl+C] exit (twice)');
  });

  it('with the room for all of it the reassurance is back, before the cue (86 columns)', () => {
    const all =
      'Enter connect a provider · your message is kept · ↓ 3 need you · [Ctrl+C] exit (twice)';
    expect(displayWidth(all)).toBe(86);
    expect(keyless(86)).toBe(all);
    expect(keyless(85)).not.toContain('your message is kept');
    expect(keyless(85)).toContain('↓ 3 need you');
  });

  it('the cue is on the row from the width its own items need (the call to connect, the cue and the exit: 63 columns), at every width above it', () => {
    const least = 'Enter connect a provider · ↓ 3 need you · [Ctrl+C] exit (twice)';
    expect(displayWidth(least)).toBe(63);
    for (let columns = 63; columns <= 200; columns += 1)
      expect(keyless(columns), String(columns)).toContain('↓ 3 need you');
    expect(keyless(62)).not.toContain('↓ 3 need you');
  });

  it('beside a NAMED item it goes first too: the head keeps its shape (the deadline, then the others) before the reassurance does', () => {
    const named = (columns: number): string =>
      landingHint(
        {
          interruptArmed: false,
          draft: { text: 'hello', cursor: 5 },
          keyless: true,
          runCanBeShown: false,
          counts: { attention: 3, sessions: 4, runs: 5 },
          urgent: AHEAD,
          columns,
        },
        displayWidth,
      ).text;
    expect(named(140)).toContain('Enter connect a provider · your message is kept · ↓ release-notes needs approval');
    expect(named(138)).toBe(
      'Enter connect a provider · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
    );
    expect(named(106)).toBe(
      'Enter connect a provider · ↓ release-notes needs approval · expires in 5m · [Ctrl+C] exit (twice)',
    );
    for (let columns = 74; columns <= 200; columns += 1)
      if (columns < 139) expect(named(columns), String(columns)).not.toContain('your message is kept');
  }); // prettier-ignore

  it('a command line has no reassurance to give up: it keeps `Enter run`, and the cue still stays', () => {
    expect(keyless(74, 3, '/mod')).toBe(
      'Enter run · [Ctrl+J] newline · ↓ 3 need you · [Ctrl+C] exit (twice)',
    );
  });
});
