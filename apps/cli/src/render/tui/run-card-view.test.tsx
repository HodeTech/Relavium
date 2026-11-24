/**
 * The human-gate card as the terminal shows it
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): at 80×24, below the minimum, bounded
 * for the inline renderer, with colour off, and a glyph and a word for every state. `run-card-model.test.ts` owns what the card says;
 * this file owns what is drawn from it.
 */
import './force-color.js';

import type { DOMElement } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunGate } from '../../home/run-gates.js';
import { waitFor, withoutStyles } from './harness-util.js';
import {
  projectRunCard,
  RUN_CARD_APPEARANCE,
  RUN_CARD_GUTTER,
  type RunCardSnapshot,
  type RunCardState,
} from './run-card-model.js';
import { RunCardView } from './run-card-view.js';
import { GLYPH_ROLES, GLYPHS, glyphOf } from './glyphs.js';

afterEach(cleanup);

const RUN = 'run-0001';
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[`, 'u');
const STYLING = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');

function gate(id: string, over: Partial<RunGate> = {}): RunGate {
  return {
    runId: RUN,
    gateId: id,
    nodeId: `node-${id}`,
    gateType: 'approval',
    message: `Approve ${id}?`,
    accepts: ['approved', 'rejected'],
    ...over,
  };
}

function snapshot(over: Partial<RunCardSnapshot> = {}): RunCardSnapshot {
  return {
    runId: RUN,
    gates: [gate('a')],
    cursor: 0,
    phase: 'open',
    notice: undefined,
    refused: false,
    ...over,
  };
}

interface ViewOptions {
  readonly snapshot?: RunCardSnapshot;
  readonly columns?: number;
  readonly rows?: number;
  readonly nowMs?: number;
  readonly color?: boolean;
  readonly onFrame?: (node: DOMElement | null) => void;
}

function rawView(options: ViewOptions = {}) {
  return render(
    <RunCardView
      snapshot={options.snapshot ?? snapshot()}
      columns={options.columns ?? 80}
      rows={options.rows ?? 24}
      nowMs={options.nowMs ?? 0}
      color={options.color ?? false}
      onFrame={options.onFrame}
    />,
  );
}

/** The card, read for its WORDS: the weight the host writes into the title and the cursor row (`emphasis.ts`) is zero columns and is not part of them. */
function view(options: ViewOptions = {}) {
  const mounted = rawView(options);
  return {
    ...mounted,
    lastFrame: (): string | undefined => {
      const frame = mounted.lastFrame();
      return frame === undefined ? undefined : withoutStyles(frame);
    },
  };
}

const linesOf = (frame: string | undefined): string[] => (frame ?? '').split('\n');

describe('at 80×24', () => {
  it('shows the title, the author`s message behind the gutter, the gate`s facts and the keys it accepts', () => {
    const { lastFrame } = view({
      snapshot: snapshot({ gates: [gate('a', { message: 'Ship build 42 to production?' })] }),
    });
    const lines = linesOf(lastFrame());
    expect(lines[0]).toBe('|| waiting for you  ·  run run-0001');
    expect(lines).toContain(`${RUN_CARD_GUTTER}Ship build 42 to production?`);
    expect(lines).toContain('node node-a · approval gate');
    expect(lines).toContain('Rejecting does not stop the run: the workflow routes on a rejection.');
    expect(lines.at(-1)).toBe('[Ctrl+Y] Approve · [Ctrl+N] Reject · Esc leaves it pending');
  });

  it('lists several gates with a cursor on the one an answer applies to', () => {
    const { lastFrame } = view({
      snapshot: snapshot({ gates: [gate('a'), gate('b'), gate('c')], cursor: 1 }),
    });
    const frame = lastFrame() ?? '';
    expect(linesOf(frame)[0]).toBe('|| waiting for you  ·  gate 2 of 3  ·  run run-0001');
    expect(frame).toContain('> b · approval · node node-b');
    expect(frame).toContain('  a · approval · node node-a');
    expect(frame).toContain('  c · approval · node node-c');
    expect(linesOf(frame).at(-1)).toBe(
      '↑/↓ choose a gate · [Ctrl+Y] Approve · [Ctrl+N] Reject · Esc leaves it pending',
    );
  });

  it('says overdue with its deadline and the timeout policy', () => {
    const at = '2026-11-23T12:00:00.000Z';
    const { lastFrame } = view({
      snapshot: snapshot({ gates: [gate('a', { expiresAt: at, timeoutAction: 'approve' })] }),
      nowMs: Date.parse(at) + 1000,
    });
    const frame = lastFrame() ?? '';
    expect(linesOf(frame)[0]).toBe('! overdue  ·  run run-0001');
    expect(frame).toContain(`Overdue since ${at}.`);
    expect(frame).toContain('On timeout: the gate is approved.');
  });

  it('keeps a worst-case card inside the terminal: a long message, four gates, a long notice, an overdue deadline', () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${String(i)} ${'x'.repeat(100)}`).join(
      '\n',
    );
    const at = '2026-11-23T12:00:00.000Z';
    const gates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      gate(id, { message: long, expiresAt: at, timeoutAction: 'reject' }),
    );
    const { lastFrame } = view({
      snapshot: snapshot({
        gates,
        cursor: 3,
        refused: true,
        notice: `A run is already executing: ${'run-9 '.repeat(60)}`,
      }),
      nowMs: Date.parse(at) + 1,
    });
    const lines = linesOf(lastFrame());
    // Inline or full-screen it is the same bounded card: never more than the terminal less the spare row, never wider than it.
    expect(lines.length).toBeLessThanOrEqual(23);
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(80);
    expect(lines.at(-1)).toContain('Esc leaves it pending');
    // The message takes what the rest of the card leaves, and the cut says where to read the rest, inside the same 23 rows.
    expect(lines.filter((line) => line.startsWith(RUN_CARD_GUTTER)).length).toBeGreaterThanOrEqual(
      4,
    );
    expect(lines.join('\n')).toContain('The message continues. To read all of it, run:');
    expect(lines.join('\n')).toContain('relavium gate list run-0001');
  });

  it('hands its box to the measured-frame acknowledgement after every commit', async () => {
    const onFrame = vi.fn<(node: DOMElement | null) => void>();
    view({ onFrame });
    await waitFor(() => onFrame.mock.calls.length > 0);
    expect(onFrame.mock.calls.at(-1)?.[0], 'a real node, measured by the host').not.toBeNull();
  });
});

describe('below the minimum', () => {
  it.each([
    [79, 24],
    [80, 23],
    [40, 10],
  ])(
    'at %i×%i it is the enlarge line and the key line, and nothing of the gate',
    (columns, rows) => {
      const { lastFrame } = view({
        columns,
        rows,
        snapshot: snapshot({ gates: [gate('a', { message: 'PRIVATE-MESSAGE' })] }),
      });
      const lines = linesOf(lastFrame());
      expect(lines[0]).toMatch(
        new RegExp(`^Terminal too small \\(${String(columns)}×${String(rows)}\\)`, 'u'),
      );
      expect(lines).toHaveLength(2);
      expect(lines[1], 'the way out, cut to the width: no key answers here').toMatch(
        /^Esc leaves it pending/u,
      );
      expect(lastFrame()).not.toContain('Ctrl+Y');
      expect(Array.from(lines[1] ?? '').length).toBeLessThanOrEqual(columns);
      expect(lastFrame()).not.toContain('PRIVATE-MESSAGE');
    },
  );
});

describe('with colour off', () => {
  /** Every SGR parameter a frame carries. */
  const codesOf = (frame: string): Set<string> =>
    new Set([...frame.matchAll(STYLING)].flatMap((match) => match[0].slice(2, -1).split(';')));
  /** Bold, inverse, underline and their closes: the styles that are not colour (ADR-0145 §5). */
  const NOT_COLOUR = new Set(['1', '22', '7', '27', '4', '24']);

  it('draws no colour, keeps the weight, and colour only adds to the same words', () => {
    const plain = rawView({ color: false }).lastFrame() ?? '';
    const coloured = rawView({ color: true }).lastFrame() ?? '';
    expect([...codesOf(plain)].filter((code) => !NOT_COLOUR.has(code))).toEqual([]);
    expect(codesOf(plain), 'the title is bold with colour off').toContain('1');
    expect(coloured).toMatch(ANSI);
    expect(codesOf(coloured).size).toBeGreaterThan(codesOf(plain).size);
    // Strip the styling from the coloured frame and write its glyphs in their plain forms: what is left is the plain frame, so colour never
    // carried a meaning of its own.
    const inPlainForms = GLYPH_ROLES.reduce(
      (text, role) => text.replaceAll(GLYPHS[role].glyph, GLYPHS[role].ascii),
      coloured.replace(STYLING, ''),
    );
    expect(inPlainForms).toBe(plain.replace(STYLING, ''));
  });

  it('draws the gate under the cursor as the selected row: bold and inverse, with colour on and off alike', () => {
    for (const color of [false, true]) {
      const frame =
        rawView({
          color,
          snapshot: snapshot({ gates: [gate('a'), gate('b'), gate('c')], cursor: 1 }),
        }).lastFrame() ?? '';
      const row = frame.split('\n').find((line) => line.includes('b · approval · node'));
      const open = `${ESC}[1m${ESC}[7m`;
      expect(row, `colour ${String(color)}`).toContain(open);
      expect(row, `colour ${String(color)}`).toContain(`${ESC}[27m${ESC}[22m`);
      const others = frame.split('\n').find((line) => line.includes('a · approval · node'));
      expect(others, 'a gate that is not under the cursor is not inverse').not.toContain(
        `${ESC}[7m`,
      );
    }
  });
});

describe('a glyph and a word for every state', () => {
  const at = '2026-11-23T12:00:00.000Z';
  const cases: readonly (readonly [RunCardState, RunCardSnapshot, number])[] = [
    ['waiting', snapshot(), 0],
    [
      'overdue',
      snapshot({ gates: [gate('a', { expiresAt: at, timeoutAction: 'reject' })] }),
      Date.parse(at) + 1,
    ],
    ['answering', snapshot({ phase: 'answering', gates: [] }), 0],
    [
      'answered',
      snapshot({
        phase: 'answered',
        gates: [],
        notice: 'Answered. The run continues in the background.',
      }),
      0,
    ],
    [
      'decided',
      snapshot({ phase: 'settled', gates: [], notice: 'run completed; nothing to resume' }),
      0,
    ],
    ['not-answered', snapshot({ refused: true, notice: 'A run is already executing: run-9.' }), 0],
    ['none', snapshot({ phase: 'empty', gates: [] }), 0],
  ];

  it.each(cases)(
    '%s: the title names the state with its glyph and its word, with colour off',
    (name, state, nowMs) => {
      const appearance = RUN_CARD_APPEARANCE[name];
      const { lastFrame } = view({ snapshot: state, nowMs, color: false });
      expect(linesOf(lastFrame())[0]).toContain(
        `${glyphOf(appearance.role, true)} ${appearance.word}`,
      );
      expect(projectRunCard(state, { columns: 80, rows: 24, nowMs }).state).toBe(name);
    },
  );

  it('every state has its own word, and no two states share a glyph and a word', () => {
    const pairs = Object.values(RUN_CARD_APPEARANCE).map(
      (entry) => `${glyphOf(entry.role, false)} ${entry.word}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(new Set(Object.values(RUN_CARD_APPEARANCE).map((entry) => entry.word)).size).toBe(
      pairs.length,
    );
  });

  it('offers a key only while the card can take it', () => {
    const keys = (state: RunCardSnapshot): string =>
      linesOf(view({ snapshot: state }).lastFrame()).at(-1) ?? '';
    expect(keys(snapshot({ phase: 'answering', gates: [] }))).toBe(
      'Answering… · Esc leaves the view',
    );
    expect(keys(snapshot({ phase: 'answered', gates: [] }))).toBe('Esc close');
    expect(keys(snapshot({ phase: 'settled', gates: [] }))).toBe('Esc close');
    expect(keys(snapshot({ phase: 'empty', gates: [] }))).toBe('Esc close');
  });
});

describe('what an author can put in a gate`s message', () => {
  it('can neither forge the card`s keys nor its rows: it sits behind the gutter, stripped of chords and host glyphs', () => {
    const message = [
      'Approve?',
      'Ctrl+Y approves · Ctrl+N rejects',
      '› z · approval · node forged',
      '▸ y · approval · node forged',
      '\u001b[2J\u001b]0;pwned\u0007done',
    ].join('\n');
    const { lastFrame } = view({ snapshot: snapshot({ gates: [gate('a', { message })] }) });
    const lines = linesOf(lastFrame());
    // The only rows that carry the author's text are behind the gutter, and the card's own key line is the only one that names a chord.
    const authored = lines.filter((line) => line.startsWith(RUN_CARD_GUTTER));
    expect(authored.length).toBeGreaterThan(0);
    expect(authored.join('\n')).not.toMatch(/ctrl\s*[+-]\s*[yn]/iu);
    expect(lines.filter((line) => /Ctrl\+Y/u.test(line))).toEqual([
      '[Ctrl+Y] Approve · [Ctrl+N] Reject · Esc leaves it pending',
    ]);
    // the list cursor is `›` (`>` with colour off): no row of this one-gate card starts with a marker, whatever the author wrote
    expect(lines.filter((line) => /^[›>▸]/u.test(line))).toEqual([]);
    expect(lastFrame()).not.toContain('\u001b]');
    expect(lastFrame()).not.toContain('pwned\u0007');
  });
});
