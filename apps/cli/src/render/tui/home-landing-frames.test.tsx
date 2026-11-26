import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeStatusFacts } from '../../home/home-status-facts.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeController } from './home-controller.js';
import { settleFrames } from './harness-util.js';
import { HomeView } from './home-view.js';
import { EXAMPLE_PROMPT, WORDMARK } from './home-layout.js';
import { tagStyles } from './legend-golden/frames.js';

/**
 * The empty Home's LANDING, frame by frame ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §1, §2, §5; MVP-11 unit 7, H1): the rows and the columns the frames `home-empty-80x24.png` and `home-empty-100x30.png` were measured to carry,
 * through a mounted `RootApp` in the alternate screen and inline, with colour and without it. The oracle is written out here and is not read
 * from `home-layout.ts`, so a wrong constant there cannot make its own test pass.
 *
 * At 80×24 (left margin 6, rail 68) in the alternate screen the wordmark is row 3, the rail row 5, the labels row 6, the notes row 7, the
 * prompt row 10, the rule row 11, the status line row 12 and the hint row 14; at 100×30 (margin 8, rail 84) they are 6, 8, 9, 10, 13, 14, 15
 * and 17. Inline there is no gap above the wordmark, so every row is that many rows higher.
 */
afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const FACTS: HomeStatusFacts = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  mode: 'ask',
  directory: '~/acme-web',
};
const STATUS_TEXT = 'next chat: anthropic · claude-haiku-5-5 · ask mode   ~/acme-web';

// eslint-disable-next-line no-control-regex -- the escape that starts a styling sequence
const SGR = /\u001b\[[0-9;]*m/gu;
const plain = (text: string): string => text.replace(SGR, '');

interface Mounted {
  readonly controller: HomeController;
  /** The rows of the frame, without styling. */
  readonly rows: () => string[];
  /** The rows of the frame with every styled run written `⟦style: text⟧`. */
  readonly tagged: () => string[];
  /** The raw bytes of the frame. */
  readonly raw: () => string;
}

function mount(options: {
  readonly cols: number;
  readonly rows: number;
  readonly alternateScreen: boolean;
  readonly color: boolean;
  readonly keyless?: boolean;
  readonly facts?: HomeStatusFacts | undefined;
  readonly showBanner?: boolean;
}): Mounted {
  const facts = 'facts' in options ? options.facts : FACTS;
  const controller = createHomeController({
    startChat: () => new Promise<never>(() => {}),
    homeStore: { read: () => EMPTY },
    schedule: () => () => {},
    ...(facts === undefined ? {} : { statusFacts: { read: () => facts } }),
    ...(options.keyless === true ? { providerSetup: { initialKeyless: true, open: vi.fn() } } : {}),
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={options.color}
      getSize={() => ({ cols: options.cols, rows: options.rows })}
      subscribeResize={() => () => {}}
      {...(options.alternateScreen ? { alternateScreen: true } : {})}
      {...(options.showBanner === undefined ? {} : { showBanner: options.showBanner })}
    />,
  );
  const raw = (): string => harness.lastFrame() ?? '';
  return {
    controller,
    rows: () => plain(raw()).split('\n'),
    tagged: () => raw().split('\n').map(tagStyles),
    raw,
  };
}

/** The oracle: where each thing is, measured from the frames. */
interface Oracle {
  readonly cols: number;
  readonly rows: number;
  readonly margin: number;
  readonly rail: number;
  /** The columns of the three nodes from the margin. */
  readonly nodes: readonly [number, number, number];
  /** The columns of the three labels and of the three notes from the margin. */
  readonly labels: readonly [number, number, number];
  readonly notes: readonly [number, number, number];
  /** The row of the wordmark in the alternate screen (the gap above it). */
  readonly gap: number;
}
const ORACLES: readonly Oracle[] = [
  {
    cols: 80,
    rows: 24,
    margin: 6,
    rail: 68,
    nodes: [0, 33, 67],
    labels: [0, 25, 55],
    notes: [0, 26, 54],
    gap: 3,
  },
  {
    cols: 100,
    rows: 30,
    margin: 8,
    rail: 84,
    nodes: [0, 41, 83],
    labels: [0, 33, 71],
    notes: [0, 34, 70],
    gap: 6,
  },
];
/** The offsets of the rows from the wordmark's: the rail, the labels, the notes, the prompt, the rule, the status line, the hint. */
const OFFSET = { rail: 2, labels: 3, notes: 4, prompt: 7, rule: 8, status: 9, hint: 11 } as const;

describe.each(ORACLES)('the landing at $cols×$rows', (oracle) => {
  describe.each([
    ['the full-screen renderer', true],
    ['the inline renderer', false],
  ] as const)('in %s', (_renderer, alternateScreen) => {
    const wordmarkRow = alternateScreen ? oracle.gap : 0;
    const at = (name: keyof typeof OFFSET): number => wordmarkRow + OFFSET[name];
    const column = (offset: number): number => oracle.margin + offset;

    describe.each([
      ['with colour', true],
      ['without colour', false],
    ] as const)('%s', (_colour, color) => {
      const frame = (): Mounted => mount({ ...oracle, alternateScreen, color });

      it('draws the wordmark, the rail, the labels and the notes on the rows and the columns of the frame', () => {
        const rows = frame().rows();
        // The wordmark: the spaced letters, hung at the margin.
        expect(rows[wordmarkRow], 'the wordmark row').toBe(
          `${' '.repeat(oracle.margin)}${WORDMARK}`,
        );
        // The rail: a node at its two ends and its middle, the line between, exactly as wide as the rail.
        const [line, start, other] = color ? ['╌', '◉', '○'] : ['.', '@', 'o'];
        const rail = rows[at('rail')] ?? '';
        expect(rail, 'the rail row').toBe(
          `${' '.repeat(oracle.margin)}${[...line.repeat(oracle.rail)]
            .map((cell, index) =>
              index === oracle.nodes[0]
                ? start
                : oracle.nodes.includes(index as never)
                  ? other
                  : cell,
            )
            .join('')}`,
        );
        // The labels and the notes, each at its own column.
        const labels = rows[at('labels')] ?? '';
        expect(labels.indexOf('Start as an agent'), 'first label').toBe(column(oracle.labels[0]));
        expect(labels.indexOf('Ship the workflow'), 'middle label').toBe(column(oracle.labels[1]));
        expect(labels.indexOf('Own every run'), 'last label').toBe(column(oracle.labels[2]));
        expect(labels.trimEnd().length, 'the last label ends at the rail’s last column').toBe(
          column(oracle.rail),
        );
        const notes = rows[at('notes')] ?? '';
        expect(notes.indexOf('talk to an agent'), 'first note').toBe(column(oracle.notes[0]));
        expect(notes.indexOf('save it as YAML'), 'middle note').toBe(column(oracle.notes[1]));
        expect(notes.indexOf('every run kept'), 'last note').toBe(column(oracle.notes[2]));
        expect(notes.trimEnd().length).toBe(column(oracle.rail));
      });

      it('draws the prompt with the example inside the row, the rule the rail’s width, the status line and the hint, and nothing above, between or below', () => {
        const rows = frame().rows();
        const example = color ? EXAMPLE_PROMPT : `e.g. ${EXAMPLE_PROMPT}`;
        const glyph = color ? '›' : '>';
        const margin = ' '.repeat(oracle.margin);
        expect(rows[at('prompt')], 'the prompt row').toBe(`${margin}${glyph} ${example}`);
        expect(rows[at('rule')], 'the rule').toBe(
          `${margin}${(color ? '─' : '-').repeat(oracle.rail)}`,
        );
        expect(rows[at('status')], 'the status line').toBe(`${margin}${STATUS_TEXT}`);
        expect(rows[at('hint')], 'the hint').toMatch(
          new RegExp(
            `^ {${String(oracle.margin)}}\\[/\\] commands · .*\\[Ctrl\\+C\\] exit \\(twice\\)$`,
            'u',
          ),
        );
        // Between the head and the prompt, and between the status line and the hint: blank rows, as the frames have.
        for (const row of [at('notes') + 1, at('notes') + 2, at('status') + 1])
          expect(rows[row]?.trim(), `row ${String(row)}`).toBe('');
        // Nothing above the wordmark but its gap, and nothing under the hint.
        for (let row = 0; row < wordmarkRow; row += 1)
          expect(rows[row]?.trim(), `gap ${String(row)}`).toBe('');
        expect(
          rows
            .slice(at('hint') + 1)
            .join('')
            .trim(),
        ).toBe('');
      });

      it('is shorter than the terminal: the whole landing, gap included, never reaches the last row', () => {
        const rows = frame().rows();
        const used = rows.findLastIndex((row) => row.trim() !== '') + 1;
        expect(used, 'the rows the landing reaches').toBe(at('hint') + 1);
        expect(used).toBeLessThanOrEqual(oracle.rows - 1);
        expect(rows.length).toBeLessThanOrEqual(oracle.rows - 1);
        for (const row of rows) expect(row.length, row).toBeLessThanOrEqual(oracle.cols);
      });
    });

    it('has the rows of the frame, in the roles the frame has them in (colour)', () => {
      const tagged = mount({ ...oracle, alternateScreen, color: true }).tagged();
      expect(tagged[wordmarkRow]?.trim()).toBe(`⟦bold,cyan: ${WORDMARK}⟧`);
      // The node the person is on is in the accent, the line and the nodes to come dim.
      expect(tagged[at('rail')]?.trim().startsWith('⟦cyan: ◉⟧⟦dim: ╌')).toBe(true);
      const labels = tagged[at('labels')] ?? '';
      expect(labels).toContain('⟦bold: Start as an agent⟧');
      expect(labels).toContain('⟦dim: Ship the workflow⟧');
      expect(labels).toContain('⟦dim: Own every run⟧');
      expect(tagged[at('notes')]?.trim().startsWith('⟦dim: talk to an agent')).toBe(true);
      // The prompt: the marker in the accent, the cursor on the example's first letter, the rest of the example dim.
      expect(tagged[at('prompt')]?.trim()).toBe(
        `⟦cyan: › ⟧⟦inverse: ${EXAMPLE_PROMPT[0] ?? ''}⟧⟦dim: ${EXAMPLE_PROMPT.slice(1)}⟧`,
      );
      expect(tagged[at('rule')]?.trim().startsWith('⟦dim: ─')).toBe(true);
      expect(tagged[at('status')]?.trim()).toBe(`⟦gray: ${STATUS_TEXT}⟧`);
      expect(tagged[at('hint')]?.trim().startsWith('⟦dim: [/] commands')).toBe(true);
    });

    it('without colour draws no colour sequence at all, and keeps the cursor on the example’s first letter, which is visible', () => {
      const m = mount({ ...oracle, alternateScreen, color: false });
      // Colour off is colour only: bold and inverse stay, nothing is coloured or dimmed.
      // eslint-disable-next-line no-control-regex -- the escape that starts a styling sequence
      const colourSequences = m.raw().match(/\u001b\[(?:2|3[0-7]|9[0-7])m/gu) ?? [];
      expect(colourSequences).toEqual([]);
      const tagged = m.tagged();
      expect(tagged[at('prompt')]?.trim()).toBe(`> ⟦inverse: e⟧.g. ${EXAMPLE_PROMPT}`);
      expect(tagged[wordmarkRow]?.trim()).toBe(`⟦bold: ${WORDMARK}⟧`);
      expect(tagged[at('labels')]).toContain('⟦bold: Start as an agent⟧');
    });
  });
});

describe('the landing without the block (`show_banner = false`): the one-line title, then the prompt block', () => {
  it.each([
    ['inline', false],
    ['full-screen', true],
  ] as const)(
    'is the spaced wordmark at the top, a blank row and the prompt block, with no rail, in the %s renderer',
    (_name, alternateScreen) => {
      const rows = mount({
        cols: 80,
        rows: 24,
        alternateScreen,
        color: true,
        showBanner: false,
      }).rows();
      // The title sits at the top (the gap is the block's), whatever the renderer.
      expect(rows[0]).toBe(`${' '.repeat(6)}${WORDMARK}`);
      expect(rows[1]?.trim()).toBe('');
      expect(rows[2]).toBe(`${' '.repeat(6)}› ${EXAMPLE_PROMPT}`);
      expect(rows[3]).toBe(`${' '.repeat(6)}${'─'.repeat(68)}`);
      expect(rows[4]?.trim()).toBe(STATUS_TEXT);
      expect(rows[5]?.trim()).toBe('');
      expect(rows[6]?.trim().startsWith('[/] commands')).toBe(true);
      expect(rows.join('\n')).not.toContain('Start as an agent');
      expect(rows.join('\n')).not.toContain('╌');
      expect(rows.findLastIndex((row) => row.trim() !== '') + 1).toBe(7);
    },
  );
});

describe('the keyless landing: the status line is the call to connect, in the accent', () => {
  it('replaces the status row and nothing else, with colour and without it', () => {
    for (const color of [true, false]) {
      const m = mount({ cols: 80, rows: 24, alternateScreen: true, color, keyless: true });
      const rows = m.rows();
      expect(rows[12]?.trim(), `colour=${String(color)}`).toBe(
        'No provider key yet · Enter connect · /providers',
      );
      expect(rows.join('\n'), 'the status line is replaced, not repeated').not.toContain(
        'next chat:',
      );
      expect(rows[14]?.trim(), 'the hint keeps its keyless words').toBe(
        'Enter connect a provider · [/] commands · [Ctrl+C] exit (twice)',
      );
      // Above the prompt there is the blank row of the gap and no line of its own: the call moved into the status row.
      expect(rows[9]?.trim()).toBe('');
      if (color)
        expect(m.tagged()[12]?.trim()).toBe(
          '⟦cyan: No provider key yet · Enter connect · /providers⟧',
        );
    }
  });
});

describe('a Home that was given no facts', () => {
  it('keeps its row: the status row is blank and the hint stays where it is', async () => {
    const m = mount({ cols: 80, rows: 24, alternateScreen: true, color: false, facts: undefined });
    await settleFrames();
    const rows = m.rows();
    expect(rows[11]?.trim()).toMatch(/^-+$/u);
    expect(rows[12]?.trim()).toBe('');
    expect(rows[14]?.trim().startsWith('[/] commands')).toBe(true);
  });
});

describe('the prompt’s cursor', () => {
  const promptRow = (editor: { text: string; cursor: number }, color: boolean): string => {
    const view = render(
      <HomeView
        snapshot={EMPTY}
        editor={editor}
        nowMs={0}
        cols={80}
        rows={24}
        color={color}
        alternateScreen
      />,
    );
    const rows = (view.lastFrame() ?? '').split('\n').map(tagStyles);
    view.unmount();
    return rows.find((row) => /^(?:⟦cyan: ›|>) /u.test(row.trim()))?.trim() ?? '';
  };

  it('is the inverse cell on the example’s first letter, and is not drawn while a popup owns the keys (the composer hands over a cursor before the text)', () => {
    expect(promptRow({ text: '', cursor: 0 }, true)).toBe(
      `⟦cyan: › ⟧⟦inverse: s⟧⟦dim: ${EXAMPLE_PROMPT.slice(1)}⟧`,
    );
    // The example stays (the text is still empty); only the cell goes.
    expect(promptRow({ text: '', cursor: -1 }, true)).toBe(`⟦cyan: › ⟧⟦dim: ${EXAMPLE_PROMPT}⟧`);
    expect(promptRow({ text: '', cursor: -1 }, false)).toBe(`> e.g. ${EXAMPLE_PROMPT}`);
    // With a draft typed the example is gone, and the same rule holds for the cell.
    expect(promptRow({ text: 'hi', cursor: 2 }, true)).toContain('inverse:  ⟧');
    expect(promptRow({ text: 'hi', cursor: -1 }, true)).not.toContain('inverse');
  });
});

describe('a notice on the landing is laid out for the columns the margin leaves', () => {
  // Lines of 78 columns: whole rows at 80 columns, but wider than the 74 the left-hung landing has, so a notice wrapped at the terminal's width
  // would wrap AGAIN when drawn, and the landing would be taller than the rows the layout counted.
  const NOTICE = Array.from({ length: 40 }, () =>
    Array.from({ length: 13 }, () => 'abcde')
      .join(' ')
      .padEnd(78, 'x'),
  ).join('\n');

  it.each([
    ['full-screen', true],
    ['inline', false],
  ] as const)(
    'stays inside 80×24 and the rows it counted, in the %s renderer',
    async (_name, alternateScreen) => {
      const m = mount({ cols: 80, rows: 24, alternateScreen, color: false });
      m.controller.setProviderState(false, NOTICE);
      await settleFrames();
      const rows = m.rows();
      expect(rows.length, 'the landing is shorter than the terminal').toBeLessThanOrEqual(23);
      for (const row of rows) expect(row.length, row).toBeLessThanOrEqual(80);
      // The prompt, the rule and the hint are all still there, and the notice says where its page is.
      expect(rows.some((row) => row.includes('e.g. summarize'))).toBe(true);
      expect(rows.some((row) => row.includes('[Ctrl+C] exit (twice)'))).toBe(true);
      expect(rows.some((row) => row.includes('PgUp/PgDn read'))).toBe(true);
      // A notice row is a whole wrapped row of 74 columns at most (the margin is 6).
      const noticeRows = rows.filter((row) => row.includes('abcde'));
      expect(noticeRows.length).toBeGreaterThan(3);
      for (const row of noticeRows) expect(row.trimEnd().length - 6, row).toBeLessThanOrEqual(74);
    },
  );
});

describe('the hosted run’s row, the exit guard and a notice on the landing', () => {
  const EXECUTING: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: 'run-0001', cancelling: false },
    last: undefined,
  };
  const view = (props: {
    readonly alternateScreen: boolean;
    readonly showBanner?: boolean;
    readonly hostedRun?: RunHostSnapshot;
    readonly notice?: string;
    readonly exitGuard?: 'confirm';
  }): string[] => {
    const rendered = render(
      <HomeView
        snapshot={EMPTY}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={80}
        rows={24}
        color={false}
        alternateScreen={props.alternateScreen}
        hostedRun={props.hostedRun}
        notice={props.notice}
        exitGuard={props.exitGuard}
        showBanner={props.showBanner}
      />,
    );
    const rows = plain(rendered.lastFrame() ?? '').split('\n');
    rendered.unmount();
    return rows;
  };
  const used = (rows: readonly string[]): number =>
    rows.findLastIndex((row) => row.trim() !== '') + 1;

  // The run's row stands between the status line and the hint (MVP-11 unit 7, the study's frame 21): the head and the prompt stay where they
  // are at rest, and the hint goes one row down.
  it.each([
    ['full-screen', true, 3],
    ['inline', false, 0],
  ] as const)(
    'stands under the status line, above the blank row and the hint, and costs one row, in the %s renderer',
    (_name, alternateScreen, gap) => {
      const rows = view({ alternateScreen, hostedRun: EXECUTING });
      // The head's five rows, two blank rows, the prompt, the rule, the status line, the run's row, a blank row, the hint.
      expect(rows[gap + 7]?.trim().startsWith('> e.g. summarize'), 'the prompt has not moved').toBe(
        true,
      );
      expect(rows[gap + 10]).toMatch(/^ {6}~ run-0001 {2}· {2}running/u);
      expect(rows[gap + 11]?.trim(), 'the blank row under it').toBe('');
      expect(rows[gap + 12]).toContain('[Ctrl+C] exit (twice)');
      expect(used(rows)).toBe(gap + 13);
    },
  );

  it('on the one-line title it stands under the status line too', () => {
    const rows = view({ alternateScreen: false, showBanner: false, hostedRun: EXECUTING });
    expect(rows[0]?.trim()).toBe(WORDMARK);
    expect(rows[1]?.trim()).toBe('');
    expect(rows[2]?.trim().startsWith('> e.g. summarize')).toBe(true);
    expect(rows[5]).toMatch(/^ {6}~ run-0001/u);
  });

  it.each([
    ['the block', undefined],
    ['the one-line title', false],
  ] as const)(
    'a notice that fills the screen leaves the landing one row short of the terminal beside a hosted run, with %s',
    (_name, showBanner) => {
      const notice = Array.from({ length: 60 }, (_, n) => `line ${String(n)}`).join('\n');
      for (const alternateScreen of [true, false]) {
        const rows = view({
          alternateScreen,
          notice,
          hostedRun: EXECUTING,
          ...(showBanner === undefined ? {} : { showBanner }),
        });
        expect(used(rows), `alternate=${String(alternateScreen)}`).toBeLessThanOrEqual(23);
        expect(rows.some((row) => row.includes('PgUp/PgDn read'))).toBe(true);
        expect(rows.some((row) => row.includes('[Ctrl+C] exit (twice)'))).toBe(true);
      }
    },
  );

  it('the exit guard replaces the prompt block (the run row with it: the card names the run), and holds the notice back', () => {
    for (const alternateScreen of [true, false]) {
      const rows = view({
        alternateScreen,
        hostedRun: EXECUTING,
        exitGuard: 'confirm',
        notice: 'NOTICE-BEHIND-THE-CARD',
      });
      const text = rows.join('\n');
      expect(text).toContain('A workflow run is executing: run-0001.');
      expect(text).toContain('[Ctrl+Y] stop the run and leave');
      expect(text, 'the notice waits behind the card').not.toContain('NOTICE-BEHIND-THE-CARD');
      expect(text, 'no prompt and no hint under the card').not.toContain('e.g. summarize');
      expect(text).not.toContain('[Ctrl+C] exit (twice)');
      expect(
        rows.some((row) => /^ {6}~ run-0001/u.test(row)),
        'the run row is part of the prompt block the card replaces',
      ).toBe(false);
      expect(used(rows)).toBeLessThanOrEqual(23);
    }
  });
});
