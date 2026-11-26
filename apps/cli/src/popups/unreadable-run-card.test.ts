/**
 * The card of a run whose log cannot be read (MVP-11 unit 7; ADR-0148 §1, §10): what it says per reason, what it is built from, what a hostile
 * id, name or status cannot make it say, and how it is drawn at the floor and at a roomy terminal, coloured and plain. The card is the
 * snapshot's: the facts come from the five fields of `HomeUnreadableRun` and nothing else, and no key but its way out does anything.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeUnreadableRun, UnreadableRunReason } from '../home/home-store.js';
import { ARROW_LOOKALIKE_RANGES, BRACKET_PAIR_RANGES } from '../render/tui/home-attention.js';
import { displayWidth } from '../render/tui/viewport.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';
import { openFrame, popupLegend } from './popup-reducer.js';
import type { PopupContext, PopupHandlers, PopupHost } from './popup-host.js';
import { COPY_CONTROL } from './popup-copy.js';
import {
  openUnreadableRunCard,
  unreadableRunContent,
  unreadableRunLines,
  unreadableRunSpec,
} from './unreadable-run-card.js';

/** What the scrub was handed, in UTF-16 units: the card reads a bounded part of a stored value before it scrubs it. */
const flowLineArguments = vi.hoisted((): number[] => []);
vi.mock('../render/tui/flow-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/tui/flow-text.js')>();
  return {
    ...actual,
    flowLine: (text: string): string => {
      flowLineArguments.push(text.length);
      return actual.flowLine(text);
    },
  };
});
/** The most a bounded read of a stored value can be: 256 code points, each at most one surrogate pair. */
const READ_BOUND_UNITS = 512;

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const RUN_ID = '3f9a1c2e-5b7d-4e11-9a0c-77d2e3f4a5b6';
const REASONS: readonly UnreadableRunReason[] = ['newer-version', 'corrupt-row', 'could-not-read'];

/** A run the summary read named in full. */
const run = (over: Partial<HomeUnreadableRun> = {}): HomeUnreadableRun => ({
  runId: RUN_ID,
  workflowSlug: 'release-notes',
  status: 'failed',
  createdAt: '2026-11-26T10:00:00.000Z',
  reason: 'corrupt-row',
  ...over,
});

/** Characters that must not be written as escapes in a file: built from their code points. */
const chars = (...codes: number[]): string => String.fromCharCode(...codes);
const ESC = chars(27);
const BEL = chars(7);
const BIDI_OVERRIDE = chars(0x202e);
const ZERO_WIDTH = chars(0x200b);
const LINE_SEPARATOR = chars(0x2028);
const C1_CSI = chars(0x9b);

const floorVariant = (color: boolean): Variant => ({
  renderer: 'alt',
  color,
  size: { cols: 80, rows: 24 },
});
const roomyVariant = (color: boolean): Variant => ({
  renderer: 'alt',
  color,
  size: { cols: 120, rows: 40 },
});

describe('what the card says per reason, at 80 columns', () => {
  it('a corrupt row: the run is named whole, and the card says only which run and why', () => {
    expect(unreadableRunLines(run({ reason: 'corrupt-row' }), NOW)).toEqual([
      'Run 3f9a1c2e cannot be read',
      `  Run id    ${RUN_ID}`,
      '  Workflow  release-notes',
      '  Status    failed',
      '  Started   2h ago',
      '',
      "This run's log has a damaged row.",
      'Other runs are not affected.',
      '',
      'Nothing was changed or started.',
    ]);
  });

  it('a row written by a newer version: update, and it reads', () => {
    expect(unreadableRunLines(run({ reason: 'newer-version' }), NOW)).toEqual([
      'Run 3f9a1c2e cannot be read',
      `  Run id    ${RUN_ID}`,
      '  Workflow  release-notes',
      '  Status    failed',
      '  Started   2h ago',
      '',
      "This run's log has a row written by a newer version of Relavium.",
      'Update Relavium and it reads.',
      '',
      'Nothing was changed or started.',
    ]);
  });

  it('a log that could not be read just now: try again', () => {
    expect(unreadableRunLines(run({ reason: 'could-not-read' }), NOW)).toEqual([
      'Run 3f9a1c2e cannot be read',
      `  Run id    ${RUN_ID}`,
      '  Workflow  release-notes',
      '  Status    failed',
      '  Started   2h ago',
      '',
      "This run's log could not be read just now. Try again.",
      '',
      'Nothing was changed or started.',
    ]);
  });

  it('every reason is a different sentence, and every card ends by saying nothing was changed or started', () => {
    const cards = REASONS.map((reason) => unreadableRunLines(run({ reason }), NOW).join('\n'));
    expect(new Set(cards).size).toBe(REASONS.length);
    for (const card of cards) expect(card.endsWith('Nothing was changed or started.')).toBe(true);
  });
});

describe('what the card knows, and what it says when it does not', () => {
  it('a run the summary read could not name says its workflow is unknown, and draws no status and no age it was not told', () => {
    const lines = unreadableRunLines({ runId: RUN_ID, reason: 'could-not-read' }, NOW);
    expect(lines).toContain('  Workflow  unknown');
    expect(lines.some((line) => line.includes('Status'))).toBe(false);
    expect(lines.some((line) => line.includes('Started'))).toBe(false);
  });

  it('an age that is not a time is no age (never `NaN`)', () => {
    const lines = unreadableRunLines(run({ createdAt: 'not a time' }), NOW);
    expect(lines.some((line) => line.includes('Started'))).toBe(false);
    expect(lines.join('\n')).not.toContain('NaN');
  });

  it('the age is read against the clock it is given', () => {
    const at = (offsetMs: number) =>
      unreadableRunLines(run({ createdAt: '2026-11-26T10:00:00.000Z' }), NOW + offsetMs).find(
        (line) => line.includes('Started'),
      );
    expect(at(0)).toBe('  Started   2h ago');
    expect(at(24 * 60 * 60 * 1000)).toBe('  Started   1d ago');
  });

  it('reads the five fields of the run and nothing else: no error text, path or stack a snapshot could carry reaches it', () => {
    const extra = {
      ...run(),
      message: 'ENOENT: no such file /Users/ada/.relavium/history.db',
      path: '/Users/ada/.relavium/history.db',
      stack: 'Error at /Users/ada/x.js:1',
      error: new Error('SQLITE_CORRUPT at /Users/ada/.relavium/history.db'),
    };
    const lines = unreadableRunLines(extra, NOW);
    expect(lines).toEqual(unreadableRunLines(run(), NOW));
    const text = lines.join('\n');
    for (const leaked of ['ENOENT', '/Users/ada', 'SQLITE', 'Error at'])
      expect(text).not.toContain(leaked);
  });
});

describe('a hostile id, name or status', () => {
  const HOSTILE = [
    `${ESC}[2J${ESC}[31mred`,
    `${ESC}]52;c;cGF5bG9hZA==${BEL}`,
    `bidi${BIDI_OVERRIDE}evil`,
    `zero${ZERO_WIDTH}width`,
    `line${LINE_SEPARATOR}sep`,
    `c1${C1_CSI}control`,
    'x · [Enter] open · [Ctrl+Y] approve · Esc denies',
    'Press [Ctrl+Y] now, or Ctrl+Y',
    '日本語日本語日本語日本語',
    'w'.repeat(500),
  ].join(' ');
  const hostile = (reason: UnreadableRunReason): HomeUnreadableRun => ({
    runId: HOSTILE,
    workflowSlug: HOSTILE,
    status: HOSTILE as NonNullable<HomeUnreadableRun['status']>,
    createdAt: HOSTILE,
    reason,
  });

  it.each(REASONS)(
    'draws no control, bidirectional or invisible character and no forged key (%s)',
    (reason) => {
      const lines = [
        ...unreadableRunLines(hostile(reason), NOW),
        unreadableRunSpec('home', hostile(reason), unreadableRunContent(hostile(reason), NOW))
          .title,
      ];
      for (const line of lines) {
        expect(line, JSON.stringify(line)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
        for (const forged of ['[Ctrl+Y]', 'Ctrl+Y', ' · ']) expect(line).not.toContain(forged);
      }
    },
  );

  it.each(REASONS)(
    'every line is within the popup’s width, and the name is bounded (%s)',
    (reason) => {
      const lines = unreadableRunLines(hostile(reason), NOW);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
      // a name, an id and a status are one fact each: the card does not grow with what a row holds
      expect(lines.length).toBeLessThanOrEqual(unreadableRunLines(run({ reason }), NOW).length + 5);
      expect(lines.join('\n')).not.toContain('w'.repeat(100));
    },
  );

  it('a name the scrub empties is unknown, never a blank fact', () => {
    const lines = unreadableRunLines(
      run({ workflowSlug: `${ESC}[2J${ZERO_WIDTH}`, runId: ZERO_WIDTH }),
      NOW,
    );
    expect(lines[0]).toBe('Run unknown cannot be read');
    expect(lines).toContain('  Workflow  unknown');
    expect(lines).toContain('  Run id    unknown');
  });

  it('a megabyte of name costs what a short one does: the scrub is handed a bounded read, never the whole value', () => {
    flowLineArguments.length = 0;
    const lines = unreadableRunLines(
      run({ workflowSlug: 'a'.repeat(2_000_000), runId: 'b'.repeat(2_000_000) }),
      NOW,
    );
    expect(flowLineArguments.length).toBeGreaterThan(0);
    expect(Math.max(...flowLineArguments)).toBeLessThanOrEqual(READ_BOUND_UNITS);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
  });
});

describe('the popup it opens', () => {
  it('is one read-only step: no control, no Enter, no answer key, no filter; its title is the short id', () => {
    const content = unreadableRunContent(run(), NOW);
    const spec = unreadableRunSpec('home', run(), content);
    expect(spec.id).toBe('unreadable-run');
    expect(spec.title).toBe('Run 3f9a1c2e');
    expect(spec.origin).toBe('home');
    expect(spec.steps).toHaveLength(1);
    const [step] = spec.steps;
    expect(step?.content).toBe(content);
    expect(step?.controls, 'the one control is the copy').toEqual([COPY_CONTROL]);
    expect(step?.legendKeep).toEqual(['c']);
    expect(step?.enter).toBeUndefined();
    expect(step?.chord).toBeUndefined();
    expect(step?.filter).toBeUndefined();
    expect(step?.final).toBeUndefined();
    expect(content.kind).toBe('report');
  });

  it('names two keys in its legend: the copy, and the way out', () => {
    const frame = openFrame(unreadableRunSpec('home', run(), unreadableRunContent(run(), NOW)), 1);
    const legend = popupLegend(frame);
    expect(legend.items).toMatchObject([{ keys: 'c', verb: 'copy' }]);
    expect(legend.exit).toMatchObject({ keys: 'Esc', verb: 'close' });
  });

  it('opens over the host it is handed, with the copy as its one handler, and says what the host answered', () => {
    const opened: unknown[] = [];
    const host = {
      openForUser: (spec: unknown, handlers: unknown) => {
        opened.push([spec, handlers]);
        return { opened: false, reason: 'card-open' } as const;
      },
    } as unknown as PopupHost;
    const result = openUnreadableRunCard({ host, run: run(), origin: 'chat', now: () => NOW });
    expect(result).toEqual({ opened: false, reason: 'card-open' });
    expect(opened).toHaveLength(1);
    const [spec, handlers] = opened[0] as [
      { id: string; origin: string; steps: { content: { lines: string[] } }[] },
      unknown,
    ];
    expect(spec.id).toBe('unreadable-run');
    expect(spec.origin, 'the origin the host asked for').toBe('chat');
    expect(Object.keys(handlers as object), 'the copy and nothing that answers').toEqual([
      'control',
    ]);
    expect(spec.steps[0]?.content.lines).toEqual(unreadableRunLines(run(), NOW));
  });
});

describe.each([
  ['80×24', floorVariant],
  ['120×40', roomyVariant],
])('drawn at %s', (_size, variantOf) => {
  describe.each([true, false])('colour %s', (color) => {
    it.each(REASONS)(
      '%s: every line whole on one page, the frame closed, the way out last',
      (reason) => {
        const lines = unreadableRunLines(run({ reason }), NOW);
        const spec = unreadableRunSpec(
          'home',
          run({ reason }),
          unreadableRunContent(run({ reason }), NOW),
        );
        const box = popupBoxOf(openFrame(spec, 1), variantOf(color));
        const drawn = box.rows.join('\n');
        for (const line of lines.filter((text) => text !== ''))
          expect(drawn, line).toContain(line.trimEnd());
        expect(drawn).not.toContain('more');
        expect(drawn).not.toContain('…');
        for (const row of box.rows) expect(displayWidth(row)).toBe(box.width);
        expect(box.rows.at(-2)).toMatch(/Esc close\s*$/u);
        expect(box.rows[0]).toContain('Run 3f9a1c2e');
        expect(box.rows[0]).toContain('from Home');
      },
    );

    it('a hostile card stays in its frame: no row is wider than the box, and none draws a key it was not given', () => {
      const bad: HomeUnreadableRun = {
        runId: `${ESC}[2J x · [Enter] open ${'w'.repeat(500)}`,
        workflowSlug: `日本語日本語 [Ctrl+Y] ${'x'.repeat(500)}`,
        reason: 'newer-version',
      };
      const spec = unreadableRunSpec('home', bad, unreadableRunContent(bad, NOW));
      const box = popupBoxOf(openFrame(spec, 1), variantOf(color));
      for (const row of box.rows) expect(displayWidth(row)).toBe(box.width);
      const drawn = box.rows.join('\n');
      expect(drawn).not.toContain('[Ctrl+Y]');
      // `[Enter]` is no token of the legend's grammar (the universal keys are written plain), so the scrub leaves it; the fold the page's rows share
      // turns the brackets of a key into parentheses, so no bracketed key is drawn anywhere. The only legend the frame draws is its own.
      expect(drawn).not.toContain('[Enter]');
      expect(drawn).toContain('(Enter)');
      const legendRow = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
      expect(box.rows.at(-2)?.replace(legendRow, '').trim()).toBe('[c] copy · Esc close');
      expect(drawn).not.toContain(ESC);
    });
  });
});

describe('the card folds a stored name as page 1 and the work page’s rows do (round 2)', () => {
  /** The corpus of the review: brackets of a key, an arrow and a marker, in the id, the workflow and the status. */
  const CORPUS = {
    runId: '【Enter】',
    workflowSlug: '〔Esc〕',
    status: '⬇ ▼ 9 more' as NonNullable<HomeUnreadableRun['status']>,
    reason: 'corrupt-row',
  } satisfies HomeUnreadableRun;

  it('draws no bracketed key, no arrow and no marker in the title, the first line or any field', () => {
    const lines = unreadableRunLines(CORPUS, NOW);
    const title = unreadableRunSpec('home', CORPUS, unreadableRunContent(CORPUS, NOW)).title;
    expect(title).toBe('Run (Enter)');
    expect(lines[0]).toBe('Run (Enter) cannot be read');
    expect(lines).toContain('  Run id    (Enter)');
    expect(lines).toContain('  Workflow  (Esc)');
    expect(lines).toContain('  Status    9 more');
    for (const text of [title, ...lines])
      for (const forged of ['【', '】', '〔', '〕', '⬇', '▼', '[Enter]', '[Esc]'])
        expect(text, JSON.stringify(text)).not.toContain(forged);
  });

  it('folds every arrow, triangle and bracket pair code point of page 1’s tables, wherever the name puts it', () => {
    const points = [...ARROW_LOOKALIKE_RANGES, ...BRACKET_PAIR_RANGES].flatMap(([from, to]) =>
      Array.from({ length: to - from + 1 }, (_, offset) => String.fromCodePoint(from + offset)),
    );
    const total = [...ARROW_LOOKALIKE_RANGES, ...BRACKET_PAIR_RANGES].reduce(
      (sum, [from, to]) => sum + (to - from + 1),
      0,
    );
    expect(points.length, 'the tables are walked whole').toBe(total);
    const own = new Set(points);
    for (const point of points) {
      const hostile: HomeUnreadableRun = {
        runId: `a${point}b`,
        workflowSlug: `${point}name${point}`,
        reason: 'corrupt-row',
      };
      const drawn = [
        unreadableRunSpec('home', hostile, unreadableRunContent(hostile, NOW)).title,
        ...unreadableRunLines(hostile, NOW),
      ].join('\n');
      for (const character of drawn)
        if (own.has(character))
          expect.fail(`U+${point.codePointAt(0)?.toString(16) ?? ''} survived`);
    }
  });

  it('turns ASCII brackets into parentheses and the marker’s plain form into nothing, as the page’s rows do', () => {
    const lines = unreadableRunLines(
      { runId: 'ab[Enter]cd', workflowSlug: 'v 9 more', reason: 'corrupt-row' },
      NOW,
    );
    expect(lines).toContain('  Run id    ab(Enter)cd');
    expect(lines).toContain('  Workflow  9 more');
  });

  it('leaves an ordinary id and name exactly as they were', () => {
    expect(unreadableRunLines(run(), NOW)).toContain(`  Run id    ${RUN_ID}`);
    expect(unreadableRunLines(run(), NOW)).toContain('  Workflow  release-notes');
    expect(unreadableRunLines(run({ workflowSlug: 'a-b_c.d' }), NOW)).toContain(
      '  Workflow  a-b_c.d',
    );
  });

  it('says on a damaged row that other runs are not affected, and says it of no other reason', () => {
    expect(unreadableRunLines(run({ reason: 'corrupt-row' }), NOW)).toContain(
      'Other runs are not affected.',
    );
    for (const reason of ['newer-version', 'could-not-read'] as const)
      expect(unreadableRunLines(run({ reason }), NOW).join('\n')).not.toContain('Other runs');
  });
});

describe('`[c] copy` sends the card, the whole id included, to the host’s clipboard', () => {
  /** The popup opened over a host that hands back its handlers, and a context that records what the popup said. */
  function opened(options: { readonly clipboard?: (text: string) => unknown; plain?: boolean }) {
    const host = {
      openForUser: (spec: unknown, handlers: PopupHandlers) => ({
        opened: true as const,
        spec,
        handlers,
      }),
    } as unknown as PopupHost;
    const result = openUnreadableRunCard({
      host,
      run: run(),
      origin: 'home',
      now: () => NOW,
      ...(options.clipboard === undefined
        ? {}
        : { clipboard: options.clipboard as (text: string) => never }),
      ...(options.plain === undefined ? {} : { plainGlyphs: options.plain }),
    }) as unknown as { handlers: PopupHandlers };
    const notices: string[] = [];
    const context = { notify: (text: string) => notices.push(text) } as unknown as PopupContext;
    return { handlers: result.handlers, context, notices };
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('copies the lines the card draws: the whole run id, the workflow, the reason and the closing sentence', async () => {
    const sent: string[] = [];
    const { handlers, context, notices } = opened({
      clipboard: (text) => {
        sent.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    handlers.control?.(context, 'c');
    await flush();
    expect(sent).toHaveLength(1);
    const text = sent[0] ?? '';
    expect(text, 'the whole id, not its short form alone').toContain(RUN_ID);
    expect(text).toContain('Run 3f9a1c2e cannot be read');
    expect(text).toContain('Workflow  release-notes');
    expect(text).toContain("This run's log has a damaged row.");
    expect(text).toContain('Other runs are not affected.');
    expect(text.endsWith('Nothing was changed or started.')).toBe(true);
    expect(text.split('\n'), 'one line to a row, as the card draws it').toHaveLength(
      unreadableRunLines(run(), NOW).length,
    );
    expect(notices).toEqual([`Run: sent ${String(text.length)} characters to the clipboard.`]);
  });

  it('copies what the card draws of a hostile id: the folded text, never the stored one', async () => {
    const sent: string[] = [];
    const host = {
      openForUser: (_spec: unknown, handlers: PopupHandlers) => ({
        opened: true as const,
        handlers,
      }),
    } as unknown as PopupHost;
    const result = openUnreadableRunCard({
      host,
      run: { runId: '【Enter】', reason: 'corrupt-row' },
      origin: 'home',
      now: () => NOW,
      clipboard: (text) => {
        sent.push(text);
        return { kind: 'written', characters: text.length };
      },
    }) as unknown as { handlers: PopupHandlers };
    result.handlers.control?.({ notify: () => undefined } as unknown as PopupContext, 'c');
    await flush();
    expect(sent[0]).toContain('(Enter)');
    expect(sent[0]).not.toContain('【');
  });

  it('says copying is not available when the host wired no clipboard, and no other key copies', async () => {
    const { handlers, context, notices } = opened({});
    handlers.control?.(context, 'c');
    expect(notices).toEqual(['Run: copying is not available here.']);
    notices.length = 0;
    let calls = 0;
    const wired = opened({
      clipboard: () => {
        calls += 1;
        return { kind: 'written', characters: 1 };
      },
    });
    for (const key of ['x', 'Enter', 'y', 'd', 'r']) wired.handlers.control?.(wired.context, key);
    await flush();
    expect(calls, 'no other key reaches the clipboard').toBe(0);
    expect(wired.handlers.enter).toBeUndefined();
    expect(wired.handlers.chord).toBeUndefined();
    expect(wired.handlers.apply).toBeUndefined();
  });

  it('is harmless to a key held down: every repeat sends the same text and changes nothing', async () => {
    const sent: string[] = [];
    const { handlers, context } = opened({
      clipboard: (text) => {
        sent.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    for (let repeat = 0; repeat < 30; repeat += 1) handlers.control?.(context, 'c');
    await flush();
    expect(new Set(sent).size, 'the same card every time').toBe(1);
  });
});
