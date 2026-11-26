/**
 * Stored text on the Home's rows (MVP-11 unit 7, round 1: the row-text scrub). A session's title, an agent's name, a workflow's name, a run's id,
 * a gate's message are stored text: a model, a project or another terminal wrote them. The work page's rows (the strip's, moved there), the
 * landing's hosted-run row and the unreadable-run row drew them through the one-line sanitiser only, so zero-width characters, U+2028/U+2029 and
 * tag characters survived, the unreadable run's id was drawn with no pass at all (a U+202E reversed the row), and a session title holding a key
 * was drawn whole while the chat's header scrubbed the same title. Every such string now passes the Home's full row scrub (`flowLine`) at the row
 * builders. The oracle is the drawn frame of the real `HomeView`, read with its styling removed, and independent of the scrubber: no control
 * character, no escape that is not a colour, no bidirectional, invisible, line-separator or tag character, no key, none of the host's row glyphs
 * (colour off, so the host draws its own plain forms), and no separator a value could forge a field with.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import { HomeView } from './home-view.js';
import { focusAt, stripRows } from './strip-focus.js';

afterEach(cleanup);

const ch = (code: number): string => String.fromCodePoint(code);
const ESC = ch(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const range = (a: number, b: number): string => `${ch(a)}-${ch(b)}`;
const BAD: readonly RegExp[] = [
  new RegExp(`[${range(0, 9)}${range(0x0b, 0x1f)}${range(0x7f, 0x9f)}]`, 'u'),
  new RegExp(
    `[${ch(0x061c)}${range(0x200b, 0x200f)}${range(0x202a, 0x202e)}${range(0x2060, 0x2069)}${ch(0x2028)}${ch(0x2029)}${ch(0xfeff)}${range(0xfff9, 0xfffb)}]`,
    'u',
  ),
  new RegExp(`[${range(0xe0000, 0xe007f)}]`, 'u'),
];
const HOSTILE: Readonly<Record<string, string>> = {
  'an OSC 8 link': `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`,
  'an OSC 52 write': `${ESC}]52;c;ZXZpbA==${ch(7)}`,
  'a CSI clear': `${ESC}[2J${ESC}[1;1Hgone${ESC}[31mred`,
  'C1 controls': `${ch(0x9b)}2Jx${ch(0x9d)}0;title${ch(0x9c)}`,
  'a bidirectional override': `abc${ch(0x202e)}edom otua${ch(0x202c)}def`,
  'zero-width characters': `a${ch(0x200b)}b${ch(0x2060)}c${ch(0xfeff)}d`,
  'line and paragraph separators': `line1${ch(0x2028)}line2${ch(0x2029)}line3`,
  'a newline and a forged status line': 'one\nanthropic · evil · auto mode   ~/forged',
  'tag characters': `a${ch(0xe0041)}${ch(0xe0042)}b`,
  'the host’s row glyphs': '› selected ▸ x ⇄ y',
  'a forged field': 'claude-haiku-4-5 · auto mode · effort max',
  'a key': `sk-ant-api03-${'A'.repeat(90)}`,
  // A key glued to a word before it (`xsk-ant-…`) is the shared scrubber's registered residual (the status line's facts have it too): not here.
};

const sessionRow = (title: string, n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  title,
  agentSlug: title,
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const runRow = (id: string, slug: string, status: HomeRunRow['status']): HomeRunRow => ({
  runId: id,
  workflowSlug: slug,
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});

/** Every kind of row of the work page, each carrying `value` in every stored field it draws, and the hosted run's row on the landing. */
function homeWith(value: string) {
  const snapshot: HomeSnapshot = {
    // (The gate rows of runs not parked here are gone with the Home's scope, MVP-11 unit 7: every parked run of this directory is the
    // parked row below, and the unreadable run carries the stored workflow name it can be named by.)
    failedRuns: [runRow(`f-${value}`, value, 'failed')],
    recentSessions: [sessionRow(value, 1)],
    // The second run has no workflow name: its row names it by its id.
    recentRuns: [
      runRow(`r-${value}`, value, 'completed'),
      { ...runRow(value, value, 'completed'), workflowSlug: undefined },
    ],
    recentAgents: [{ agentSlug: value, lastUsedAt: '2026-11-23T00:00:00.000Z' }],
    unreadableRuns: [
      {
        runId: value,
        workflowSlug: value,
        status: 'failed',
        createdAt: '2026-11-23T00:00:00.000Z',
        reason: 'corrupt-row',
      },
    ],
    totals: { attention: 3, sessions: 1, runs: 2 },
    isEmpty: false,
  };
  const parked: readonly ParkedRunRow[] = [
    { runId: `p-${value}`, kind: 'approval', gates: 1, workflow: value },
  ];
  const hosted: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: value, cancelling: false },
    last: undefined,
  };
  return { snapshot, parked, hosted };
}

function draw(value: string, page: 'start' | 'work', rows = 40): string {
  const { snapshot, parked, hosted } = homeWith(value);
  const view = render(
    <HomeView
      snapshot={snapshot}
      parkedRuns={parked}
      editor={{ text: '', cursor: 0 }}
      nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
      cols={120}
      rows={rows}
      color={false}
      alternateScreen
      page={page}
      stripFocus={page === 'work' ? focusAt(stripRows(parked, snapshot), 0) : undefined}
      hostedRun={hosted}
    />,
  );
  const frame = (view.lastFrame() ?? '').replace(SGR, '');
  view.unmount();
  return frame;
}

describe.each(['work', 'start'] as const)('stored text on the %s page', (page) => {
  it.each(Object.entries(HOSTILE))('%s', (_name, value) => {
    const frame = draw(value, page);
    expect(frame, 'no escape that is not a colour').not.toContain(ESC);
    for (const bad of BAD) expect(frame).not.toMatch(bad);
    expect(frame, 'no key').not.toMatch(/sk-ant-api03-[AB]{6}/u);
    expect(frame, 'none of the host’s row glyphs from a value').not.toMatch(/[›▸⇄]/u);
    expect(frame, 'no field forged with the separator').not.toContain('auto mode · effort');
    expect(frame, 'no status line forged on a row').not.toMatch(/anthropic · evil/u);
  });
});

it('the rows still say what the person needs: a plain title, workflow and id are drawn as they are', () => {
  const frame = draw('nightly-build', 'work');
  expect(frame).toContain('nightly-build');
  expect(frame).toContain('Attention required');
});
