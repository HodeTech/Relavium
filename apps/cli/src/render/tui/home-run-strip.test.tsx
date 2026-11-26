/**
 * The Home's run row and its exit-guard card, as drawn
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §6): present only while a run is
 * active, a glyph and a word with colour off, and never more than the 80×24 floor of
 * [ADR-0122](../../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §7.
 */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { HomeView } from './home-view.js';
import { HOSTED_RUN_EXIT_BOUND_MS } from './tui-constants.js';

const RUN_ID = '0b8c2f4e-9d4a-4f6e-8a51-3c7d1e2f9a60';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const running = (cancelling = false): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId: RUN_ID, cancelling },
  last: undefined,
});

const session = (n: number) => ({
  sessionId: `session-${String(n)}`,
  title: `Conversation ${String(n)} ${'long title '.repeat(30)}`,
  workingDir: `/workspace/${'long directory/'.repeat(30)}`,
  agentSlug: 'chat',
  modelId: 'model',
  status: 'ended' as const,
  updatedAt: '2026-11-10T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const FULL: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: Array.from({ length: 8 }, (_, n) => session(n)),
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: Array.from({ length: 50 }, (_, n) => ({
    runId: `run-${String(n)}`,
    reason: 'corrupt-row' as const,
  })),
  totals: { attention: 50, sessions: 8, runs: 0 },
  isEmpty: false,
};

function frameOf(props: {
  readonly snapshot?: HomeSnapshot;
  readonly hostedRun?: RunHostSnapshot | undefined;
  readonly exitGuard?: 'confirm' | 'stopping';
  readonly notice?: string;
  readonly keyless?: boolean;
  readonly cols?: number;
  readonly rows?: number;
  readonly color?: boolean;
  readonly showBanner?: boolean;
}): string {
  const view = render(
    <HomeView
      snapshot={props.snapshot ?? EMPTY}
      editor={{ text: '', cursor: 0 }}
      nowMs={0}
      cols={props.cols ?? 80}
      rows={props.rows ?? 24}
      color={props.color ?? false}
      hostedRun={props.hostedRun}
      exitGuard={props.exitGuard}
      notice={props.notice}
      keyless={props.keyless === true}
      showBanner={props.showBanner}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

const rowsOf = (frame: string): string[] => frame.split('\n');
/**
 * The strip's run row, in the form the colour setting draws (these frames are drawn with colour off): the running glyph `~`, the cancelling
 * `#` or the starting `..`, then the run's id (or `run`), then its state as a word.
 */
const RUN_ROW = /^\s*(?:~|#|\.\.) \S+ {2}· {2}(?:running|cancelling|starting)/u;
const runRows = (frame: string): string[] => rowsOf(frame).filter((line) => RUN_ROW.test(line));

const hintRow = (frame: string): string =>
  rowsOf(frame).find((line) => line.includes('[Ctrl+C] exit (twice)')) ?? '';

describe('the landing hint while a leg executes', () => {
  // The run's own row says `Enter show it` (between the status line and the hint: MVP-11 unit 7, the study's frame 21), so the hint does not say
  // it a second time: it keeps its own doors (the indicator, or the empty Home's sentence).
  it.each([
    // FULL holds 50 unreadable runs under Attention (the store's true total) and 8 sessions: page 1 names the most urgent item (MVP-11 unit 7)
    // and counts the others; at 80 columns the session count and the long form of `+49 more` give way.
    ['a Home with sessions', FULL, '↓ a run cannot be read · +49 more', 80],
    ['an empty Home at 100 columns', EMPTY, 'type a message to chat', 100],
  ] as const)(
    'leaves `Enter show it` to the run row, and keeps its own door (%s)',
    (_name, snapshot, door, cols) => {
      const frame = frameOf({ snapshot, hostedRun: running(), cols });
      const hint = hintRow(frame).trim();
      expect(hint).not.toContain('Enter show it');
      expect(runRows(frame)[0]).toContain('Enter show it');
      expect(hint).toContain(door);
      expect(hint.length, 'it fits the terminal').toBeLessThanOrEqual(cols);
    },
  );

  it('on the empty Home at 80 columns keeps the example and the exit and drops the standing sentence, whole (ADR-0145 §3)', () => {
    const hint = hintRow(frameOf({ snapshot: EMPTY, hostedRun: running() })).trim();
    expect(hint).toBe('[/] commands · Tab fill the example · [Ctrl+C] exit (twice)');
    expect(hint.length, 'it fits the 74 columns after the margin').toBeLessThanOrEqual(74);
  });

  it.each([
    ['no host', undefined],
    ['an idle host', IDLE],
    ['a leg still preparing', { launching: true, active: undefined, last: undefined }],
  ] as const)('does not say it with %s: there is nothing to show', (_name, hostedRun) => {
    expect(hintRow(frameOf({ hostedRun }))).not.toContain('Enter show it');
  });
});

describe('the run row', () => {
  it('is present with an active run: the glyph, the id and a state word, with colour off', () => {
    const rows = runRows(frameOf({ hostedRun: running() }));
    expect(rows).toHaveLength(1);
    // The short id, the first eight characters, never the whole id (MVP-11 unit 7, round 1: OB74).
    expect(rows[0]?.trimStart()).toMatch(new RegExp(`^~ ${RUN_ID.slice(0, 8)}  ·`, 'u'));
    expect(rows[0]).toContain('running');
  });

  it('says cancelling once the stop was requested', () => {
    expect(runRows(frameOf({ hostedRun: running(true) }))[0]).toContain('cancelling');
  });

  it('says starting while a leg is being prepared', () => {
    const rows = runRows(
      frameOf({ hostedRun: { launching: true, active: undefined, last: undefined } }),
    );
    expect(rows[0]).toContain('starting');
  });

  it.each([
    ['no host', undefined],
    ['an idle host', IDLE],
  ] as const)('is absent with %s: no row, no glyph', (_name, hostedRun) => {
    const frame = frameOf({ hostedRun });
    expect(runRows(frame)).toEqual([]);
    expect(frame).not.toContain('running');
  });

  it('tells the person how to come back to a live run: the row says `Enter show it` once the run has an id, and not before', () => {
    expect(runRows(frameOf({ hostedRun: running() }))[0]).toContain('Enter show it');
    expect(runRows(frameOf({ hostedRun: running(true) }))[0]).toContain('Enter show it');
    expect(
      runRows(frameOf({ hostedRun: { launching: true, active: undefined, last: undefined } }))[0],
      'a leg still preparing has no run to show',
    ).not.toContain('Enter show it');
  });

  it('is one line that fits 80 columns', () => {
    const [row] = runRows(frameOf({ hostedRun: running(true) }));
    expect(row?.length).toBeLessThanOrEqual(80);
  });

  it('keeps the whole Home inside 80×24 with the row, a full strip, a long notice and a keyless Home: the prompt is still there, and the setup line waits (Enter shows the run first)', () => {
    const frame = frameOf({
      snapshot: FULL,
      hostedRun: running(),
      notice: 'notice '.repeat(100),
      keyless: true,
    });
    expect(rowsOf(frame).length).toBeLessThanOrEqual(24);
    // (The harness draws on a 100-column stream, so a long session title is not the line to measure: the run row and the card are.)
    for (const line of [...runRows(frame)]) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(runRows(frame)).toHaveLength(1);
    // `Enter` at the empty prompt shows the run before it sets a provider up, so the setup line is not drawn beside `Enter show it`.
    expect(frame).not.toContain('Connect a provider');
    expect(frame).toContain('Enter show it');
    expect(frame).toContain('[Ctrl+C] exit (twice)');
  });

  it('reserves its row from a notice that fills the screen, so the Home is still 24 rows with the prompt in view', () => {
    // An empty strip and a notice longer than the screen: the notice takes every row the layout leaves it, so a row the layout did not
    // know about would push the Home to 25 rows.
    const notice = Array.from({ length: 60 }, (_, n) => `line ${String(n)}`).join('\n');
    const withRow = frameOf({ hostedRun: running(), notice, showBanner: false });
    expect(rowsOf(withRow).length).toBeLessThanOrEqual(24);
    expect(runRows(withRow)).toHaveLength(1);
    expect(withRow).toContain('[Ctrl+C] exit (twice)');
    expect(withRow).toContain('PgUp/PgDn read');
    expect(rowsOf(frameOf({ notice, showBanner: false })).length).toBeLessThanOrEqual(24);
  });

  it('costs exactly one row against the same Home without it', () => {
    const without = rowsOf(frameOf({ snapshot: FULL, notice: 'notice '.repeat(100) })).length;
    const withRow = rowsOf(
      frameOf({ snapshot: FULL, hostedRun: running(), notice: 'notice '.repeat(100) }),
    ).length;
    expect(withRow).toBeLessThanOrEqual(24);
    expect(withRow).toBeLessThanOrEqual(without + 1);
  });
});

describe('the exit-guard card', () => {
  it('replaces the prompt and its hint, names the run and the keys, and fits 80×24 with a full strip', () => {
    const frame = frameOf({
      snapshot: FULL,
      hostedRun: running(),
      exitGuard: 'confirm',
      notice: 'notice '.repeat(100),
      keyless: true,
    });
    expect(frame).toContain(`A workflow run is executing: ${RUN_ID}.`);
    expect(frame).toContain('[Ctrl+Y] stop the run and leave');
    expect(frame).toContain('Esc / [Ctrl+C] / [Ctrl+N] stay');
    expect(frame, 'no prompt hint behind the card').not.toContain('[Ctrl+C] exit (twice)');
    expect(frame, 'the notice waits behind the card').not.toContain('notice notice');
    expect(rowsOf(frame).length).toBeLessThanOrEqual(24);
    // Measured as the terminal draws it (the title is bold, and its SGR pair takes no column): on the landing the card is left-hung at the margin.
    const sgr = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');
    for (const line of rowsOf(frame).filter((row) =>
      /Ctrl\+Y|workflow run|^\s*(?:~|#|\.\.) |cannot be resumed/u.test(row),
    ))
      expect(line.replace(sgr, '').length, line).toBeLessThanOrEqual(80);
    // The card takes the place of the landing's prompt block, the run's row with it (the row stands under the status line: MVP-11 unit 7);
    // the card names the run itself.
    expect(
      runRows(frame),
      'the run row is part of the prompt block the card replaces',
    ).toHaveLength(0);
  });

  it('says it is stopping once confirmed', () => {
    const frame = frameOf({ hostedRun: running(true), exitGuard: 'stopping' });
    expect(frame).toContain('Stopping the run…');
    expect(frame).toContain(
      `within about ${String(HOSTED_RUN_EXIT_BOUND_MS / 1000)}s`, // the grace and then the host's settle bound
    );
  });

  it('is drawn in the below-minimum degrade too, where the Home cannot show anything else', () => {
    const frame = frameOf({ hostedRun: running(), exitGuard: 'confirm', cols: 60, rows: 20 });
    expect(frame).toContain('Terminal too small (60×20)');
    expect(frame).toContain('[Ctrl+Y] stop the run and leave');
  });

  it('is absent when it is not open', () => {
    expect(frameOf({ hostedRun: running() })).not.toContain('Ctrl+Y');
  });
});
