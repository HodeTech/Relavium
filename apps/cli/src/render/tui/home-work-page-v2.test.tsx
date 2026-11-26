/**
 * The work page v2 as DRAWN (MVP-11 unit 7; the maintainer's rulings 1–4 of 2026-11-26): the sections windowed by the allocation with the
 * `▲`/`▼ N more` markers whose N is the TRUE total, one row per item with the rows' own words, at 80×24, 100×30 and 120×40, in the alternate
 * screen and inline, with colour on and off. The oracle is the frame's grid: its rows in order and their columns.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { HomeView } from './home-view.js';
import { focusAt, stripRows, type StripFocus } from './strip-focus.js';
import { KEYS, mountHome } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { displayWidth } from './viewport.js';

afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const run = (id: string, status: HomeRunRow['status'], minutes: number): HomeRunRow => ({
  runId: `${id}-0000-4000-8000-000000000000`,
  workflowSlug: `wf-${id}`,
  status,
  createdAt: ago(minutes + 5),
  startedAt: ago(minutes + 5),
  completedAt: ago(minutes),
  totalCostMicrocents: 4_000_000,
  usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
});
const session = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: '/work/here',
  title: `Session ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: ago(n * 10),
  totalCostMicrocents: 0,
  usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
});
const parked = (n: number): ParkedRunRow => ({
  runId: `p${String(n)}000000-0000-4000-8000-000000000000`,
  kind: 'approval',
  gates: 1,
  workflow: `release-${String(n)}`,
  expiresAt: new Date(NOW + (n + 1) * 5 * 60_000).toISOString(),
});

/** Five Attention items (three parked runs, two failed), five sessions, five runs: the (5, 5, 5) the brief's table asks for. */
const PARKED = [parked(1), parked(2), parked(3)];
const FIVE: HomeSnapshot = {
  attention: { failedRuns: [run('f1', 'failed', 60), run('f2', 'failed', 120)] },
  recentSessions: [1, 2, 3, 4, 5].map(session),
  recentRuns: [1, 2, 3, 4, 5].map((n) => run(`r${String(n)}`, 'completed', n * 30)),
  recentAgents: [{ agentSlug: 'reviewer', lastUsedAt: ago(30) }],
  unreadableRuns: [],
  totals: { attention: 5, sessions: 5, runs: 5 },
  isEmpty: false,
};

interface Draw {
  readonly snapshot?: HomeSnapshot;
  readonly parked?: readonly ParkedRunRow[];
  readonly cols: number;
  readonly rows: number;
  readonly color?: boolean;
  readonly alternateScreen?: boolean;
  readonly focus?: StripFocus | undefined;
}

function frame(draw: Draw): { readonly raw: string; readonly rows: readonly string[] } {
  const view = render(
    <HomeView
      page="work"
      snapshot={draw.snapshot ?? FIVE}
      parkedRuns={draw.parked ?? PARKED}
      editor={{ text: '', cursor: 0 }}
      nowMs={NOW}
      cols={draw.cols}
      rows={draw.rows}
      color={draw.color ?? false}
      alternateScreen={draw.alternateScreen ?? true}
      stripFocus={draw.focus}
    />,
  );
  const raw = view.lastFrame() ?? '';
  view.unmount();
  return { raw, rows: raw.replace(SGR, '').split('\n') };
}

/** The list region's rows: from the way back's blank row to the docked block (the frame less its first two rows and its last five). */
const listOf = (rows: readonly string[]): string[] =>
  rows.slice(2, rows.length - 5).map((row) => row.trimEnd());

describe('the (5, 5, 5) page as drawn', () => {
  it('80×24: Attention keeps four rows and `▼ 1 more`; the sessions and the runs two each and their markers, every row one line at its column', () => {
    const { rows } = frame({ cols: 80, rows: 24 });
    expect(rows).toHaveLength(23);
    const pad = ' '.repeat(6);
    expect(listOf(rows)).toEqual([
      `${pad}Attention required`,
      `${pad}    || release-1 · approval · expires in 10m · p1000000`,
      `${pad}    || release-2 · approval · expires in 15m · p2000000`,
      `${pad}    || release-3 · approval · expires in 20m · p3000000`,
      `${pad}    x wf-f1 · failed 1h ago · $0.0400 · f1-0000-`,
      `${pad}    v 1 more`,
      '',
      `${pad}Continue`,
      `${pad}  Sessions`,
      `${pad}    Session 1 · chat · 10m ago · free`,
      `${pad}    Session 2 · chat · 20m ago · free`,
      `${pad}    v 3 more`,
      `${pad}  Runs`,
      `${pad}    wf-r1 · completed · 30m ago · $0.0400 · r1-0000-`,
      `${pad}    wf-r2 · completed · 1h ago · $0.0400 · r2-0000-`,
      `${pad}    v 3 more`,
    ]);
  }); // prettier-ignore

  it('100×30: the caps open into the spare rows: every item of the three sections, and the agent last', () => {
    const { rows } = frame({ cols: 100, rows: 30 });
    expect(rows).toHaveLength(29);
    const list = listOf(rows).map((row) => row.trim());
    expect(list.filter((row) => row.startsWith('||'))).toHaveLength(3);
    expect(list.filter((row) => row.startsWith('x '))).toHaveLength(2);
    expect(list.filter((row) => row.startsWith('Session '))).toHaveLength(5);
    expect(list.filter((row) => row.startsWith('wf-r'))).toHaveLength(5);
    expect(list.some((row) => /^v \d+ more/u.test(row))).toBe(false);
    expect(list.at(-1)).toBe('reviewer · 30m ago');
  });

  it.each([
    ['alt', true],
    ['alt', false],
    ['inline', true],
    ['inline', false],
  ] as const)('120×40 (%s, colour %s), drawn by the terminal emulator: every row whole, the agent last, the docked block the last five', async (renderer, color) => {
    // The Ink test renderer is 100 columns wide: a 120-column page is drawn by the surface matrix's terminal emulator, with the parked runs
    // the controller reads through its gate-card port and the clock of this file.
    const variant: Variant = { renderer, color, size: { cols: 120, rows: 40 } };
    const home = mountHome(variant, {
      snapshot: FIVE,
      props: { nowMs: () => NOW },
      deps: {
        gateCards: {
          list: () => PARKED,
          read: () => undefined,
          resume: () => new Promise(() => {}),
          guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
        },
      },
    });
    try {
      await home.settle();
      home.key(KEYS.down);
      await home.until(() => home.controller.getSnapshot().stripFocus !== undefined && home.homePainted());
      const rows = home.text().split('\n').map((row) => row.trimEnd());
      for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(120);
      const list = rows.map((row) => row.trim());
      const marker = color ? '›' : '>';
      const paused = color ? '‖' : '||';
      expect(list).toContain(`${marker} ${paused} release-1 · approval · expires in 10m · p1000000`);
      expect(list).toContain('Session 5 · chat · 50m ago · free');
      expect(list).toContain('wf-r5 · completed · 2h ago · $0.0400 · r5-0000-');
      expect(list).toContain('reviewer · 30m ago');
      expect(list.some((row) => /^[▼v] \d+ more/u.test(row))).toBe(false);
      const prompt = list.findIndex((row) => row.endsWith('type a message, or / for commands'));
      expect(prompt, 'the docked prompt').toBeGreaterThan(0);
      expect(list[prompt + 3]).toBe('↑/↓ select · Enter open · type to chat · Esc start page');
    } finally {
      home.unmount();
    }
  }); // prettier-ignore

  it.each([
    [80, 24],
    [100, 30],
  ] as const)('%i×%i: inline draws the same rows as the alternate screen, and no row is wider than the terminal', (cols, rows) => {
    const alt = frame({ cols, rows });
    const inline = frame({ cols, rows, alternateScreen: false });
    expect(inline.rows.map((row) => row.trimEnd())).toEqual(alt.rows.map((row) => row.trimEnd()));
    for (const row of alt.rows) expect(displayWidth(row), row).toBeLessThanOrEqual(cols);
  }); // prettier-ignore

  it('colour on draws the same words as colour off, the `▲`/`▼` in their own glyphs, the markers dim', () => {
    const plain = frame({ cols: 80, rows: 24 });
    const coloured = frame({ cols: 80, rows: 24, color: true });
    const words = (rows: readonly string[]): string[] =>
      rows.map((row) => row.replace(/[‖✗]/gu, '').replace(/\|\||\bx\b/gu, '').replace(/[▼v] /gu, 'M ').trimEnd());
    expect(words(listOf(coloured.rows))).toEqual(words(listOf(plain.rows)));
    // the marker column (two blanks) and the marker, dim
    expect(coloured.raw).toContain(`${ESC}[2m  ▼ 1 more`);
    expect(plain.raw).not.toContain('▼');
  }); // prettier-ignore
});

describe('the marker counts the TRUE total and says where the rest are only where `↓` cannot reach them', () => {
  it('rows the store counted but did not load: `▼ N more · /workflows` (runs) and `· /resume` (sessions); loaded rows: only `▼ N more`', () => {
    const many: HomeSnapshot = { ...FIVE, totals: { attention: 32, sessions: 40, runs: 77 } };
    const list = listOf(frame({ snapshot: many, cols: 80, rows: 24 }).rows).map((row) =>
      row.trim(),
    );
    expect(list).toContain('v 28 more · /workflows');
    expect(list).toContain('v 38 more · /resume');
    expect(list).toContain('v 75 more · /workflows');
    // the rows shown + N = the total, section by section
    const attention = list.filter((row) => row.startsWith('||') || row.startsWith('x ')).length;
    expect(attention + 28).toBe(32);
  });

  it('a window scrolled to the focus says `▲ N more` above it, and every Attention row the keys reach is drawn when focused', () => {
    const rows = stripRows(PARKED, FIVE);
    for (let index = 0; index < 5; index += 1) {
      const list = listOf(frame({ cols: 80, rows: 24, focus: focusAt(rows, index) }).rows).map((row) => row.trim());
      expect(list.filter((row) => row.startsWith('> ')), `focus on ${String(index)}`).toHaveLength(1);
    }
    const last = listOf(frame({ cols: 80, rows: 24, focus: focusAt(rows, 4) }).rows).map((row) => row.trim());
    expect(last).toContain('^ 1 more');
    expect(last).toContain('> x wf-f2 · failed 2h ago · $0.0400 · f2-0000-');
  }); // prettier-ignore

  it('the agents, which `↓` never reaches, say where they are when some are hidden', () => {
    const agents: HomeSnapshot = {
      ...FIVE,
      attention: { failedRuns: [] },
      recentSessions: [session(1)],
      recentRuns: [],
      recentAgents: ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ agentSlug: slug, lastUsedAt: ago(5) })),
      totals: { attention: 0, sessions: 1, runs: 0 },
    };
    const list = listOf(frame({ snapshot: agents, parked: [], cols: 80, rows: 24 }).rows).map((row) => row.trim());
    // five agents, their cap three: three rows and the marker for the other two
    expect(list).toContain('v 2 more · /agents');
  }); // prettier-ignore
});

describe('the rows the rulings word (ruling 4)', () => {
  it('an unreadable run: `⚠ id · workflow · cannot be read`, its workflow only when the summary read named it', () => {
    const broken: HomeSnapshot = {
      ...FIVE,
      attention: { failedRuns: [] },
      unreadableRuns: [
        { runId: 'u1000000-0000-4000-8000-000000000000', workflowSlug: 'nightly', reason: 'corrupt-row' },
        { runId: 'u2000000-0000-4000-8000-000000000000', reason: 'newer-version' },
      ],
      totals: { attention: 2, sessions: 5, runs: 5 },
    };
    const coloured = frame({ snapshot: broken, parked: [], cols: 100, rows: 30, color: true });
    const list = coloured.rows.map((row) => row.trim());
    expect(list).toContain('⚠ u1000000 · nightly · cannot be read');
    expect(list).toContain('⚠ u2000000 · cannot be read');
  }); // prettier-ignore

  it('no row of the page names a key: the hint row is the one place `Enter` is named', () => {
    const rows = stripRows(PARKED, FIVE);
    const { rows: drawn } = frame({ cols: 100, rows: 30, focus: focusAt(rows, 0) });
    const list = listOf(drawn);
    expect(list.join('\n')).not.toMatch(/Enter|↑\/↓|select/u);
    expect(drawn.at(-1)?.trim()).toBe('↑/↓ select · Enter open · type to chat · Esc start page');
  });
});
