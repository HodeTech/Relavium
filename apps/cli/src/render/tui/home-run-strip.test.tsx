/**
 * The Home's `▶` run row and its exit-guard card, as drawn
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §6): present only while a run is
 * active, a glyph and a word with colour off, and never more than the 80×24 floor of
 * [ADR-0122](../../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §7.
 */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { HomeView } from './home-view.js';

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
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const FULL: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: Array.from({ length: 8 }, (_, n) => session(n)),
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: Array.from({ length: 50 }, (_, n) => `run-${String(n)}`),
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
const runRows = (frame: string): string[] => rowsOf(frame).filter((line) => line.includes('▶'));

describe('the ▶ row', () => {
  it('is present with an active run: the glyph, the id and a state word, with colour off', () => {
    const rows = runRows(frameOf({ hostedRun: running() }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`▶ ${RUN_ID}`);
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
    expect(frame).not.toContain('▶');
    expect(frame).not.toContain('running');
  });

  it('is one line that fits 80 columns', () => {
    const [row] = runRows(frameOf({ hostedRun: running(true) }));
    expect(row?.length).toBeLessThanOrEqual(80);
  });

  it('keeps the whole Home inside 80×24 with the row, a full strip, a long notice and a keyless banner: the prompt is still there', () => {
    const frame = frameOf({
      snapshot: FULL,
      hostedRun: running(),
      notice: 'notice '.repeat(100),
      keyless: true,
    });
    expect(rowsOf(frame).length).toBeLessThanOrEqual(24);
    // (The harness draws on a 100-column stream, so a long session title is not the line to measure: the run row and the card are.)
    for (const line of [...runRows(frame)]) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(frame).toContain('▶');
    expect(frame).toContain('Connect a provider');
    expect(frame).toContain('Ctrl+C twice to exit');
  });

  it('reserves its row from a notice that fills the screen, so the Home is still 24 rows with the prompt in view', () => {
    // An empty strip and a notice longer than the screen: the notice takes every row the layout leaves it, so a row the layout did not
    // know about would push the Home to 25 rows.
    const notice = Array.from({ length: 60 }, (_, n) => `line ${String(n)}`).join('\n');
    const withRow = frameOf({ hostedRun: running(), notice, showBanner: false });
    expect(rowsOf(withRow).length).toBeLessThanOrEqual(24);
    expect(withRow).toContain('▶');
    expect(withRow).toContain('Ctrl+C twice to exit');
    expect(withRow).toContain('PgUp/PgDn to read');
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
    expect(frame).toContain('Ctrl+Y stop the run and leave');
    expect(frame).toContain('Esc, Ctrl+C or Ctrl+N stay');
    expect(frame, 'no prompt hint behind the card').not.toContain('Ctrl+C twice to exit');
    expect(frame, 'the notice waits behind the card').not.toContain('notice notice');
    expect(rowsOf(frame).length).toBeLessThanOrEqual(24);
    for (const line of rowsOf(frame).filter((row) =>
      /Ctrl\+Y|workflow run|▶|cannot be resumed/u.test(row),
    ))
      expect(line.length, line).toBeLessThanOrEqual(80);
    expect(frame, 'the run row stays').toContain('▶');
  });

  it('says it is stopping once confirmed', () => {
    const frame = frameOf({ hostedRun: running(true), exitGuard: 'stopping' });
    expect(frame).toContain('Stopping the run…');
    expect(frame).toContain('within 10 s');
  });

  it('is drawn in the below-minimum degrade too, where the Home cannot show anything else', () => {
    const frame = frameOf({ hostedRun: running(), exitGuard: 'confirm', cols: 60, rows: 20 });
    expect(frame).toContain('Terminal too small (60×20)');
    expect(frame).toContain('Ctrl+Y stop the run and leave');
  });

  it('is absent when it is not open', () => {
    expect(frameOf({ hostedRun: running() })).not.toContain('Ctrl+Y');
  });
});
