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
import { yieldBetweenTests } from '../event-loop.test-support.js';

// this file's tests run for seconds back to back: the event loop turns between them (`../event-loop.test-support.ts`)
yieldBetweenTests();

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
  failedRuns: [run('f1', 'failed', 60), run('f2', 'failed', 120)],
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

/**
 * The list region's rows: from under the way back to the docked block (the frame less its head and its last five rows). The head is the way
 * back alone below 26 terminal rows and the way back and a blank row from 26 (whitespace gives way before words: `workHeadRows`); the blank
 * row, when there is one, is the list's first row here.
 */
const listOf = (rows: readonly string[]): string[] =>
  rows.slice(1, rows.length - 5).map((row) => row.trimEnd());

/**
 * A row with the runs of blanks inside its words made one: the rows' own words are the labels' (`home-projection.ts`, `home-attention.ts`),
 * pinned by their own tests; what this file pins is which rows of which section are drawn and where, so the glyph column's padding (a
 * plain `x` is one column and `||` two) is not part of it.
 */
const squash = (row: string): string => row.replace(/(?<=\S) {2,}(?=\S)/gu, ' ');

describe('the (5, 5, 5) page as drawn', () => {
  it('80×24: Attention shows all five (a `▼ 1 more` would take the line the fifth row takes), the sessions and the runs three each and their markers; no blank row under the way back or above `Continue`; every row one line at its column', () => {
    const { rows } = frame({ cols: 80, rows: 24 });
    expect(rows).toHaveLength(23);
    const pad = ' '.repeat(6);
    expect(rows[0]).toBe(`${pad}↑ start page`);
    expect(listOf(rows).map(squash)).toEqual([
      `${pad}Attention required`,
      `${pad}    || release-1 · approval · expires in 10m · p1000000`,
      `${pad}    || release-2 · approval · expires in 15m · p2000000`,
      `${pad}    || release-3 · approval · expires in 20m · p3000000`,
      `${pad}    x wf-f1 · failed 1h ago · $0.0400 · f1-0000-`,
      `${pad}    x wf-f2 · failed 2h ago · $0.0400 · f2-0000-`,
      `${pad}Continue`,
      `${pad}  Sessions`,
      `${pad}    Session 1 · chat · 10m ago · free`,
      `${pad}    Session 2 · chat · 20m ago · free`,
      `${pad}    Session 3 · chat · 30m ago · free`,
      `${pad}    v 2 more`,
      `${pad}  Runs`,
      `${pad}    wf-r1 · completed · 30m ago · $0.0400 · r1-0000-`,
      `${pad}    wf-r2 · completed · 1h ago · $0.0400 · r2-0000-`,
      `${pad}    wf-r3 · completed · 1h ago · $0.0400 · r3-0000-`,
      `${pad}    v 2 more`,
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
      rows.map((row) => row.replace(/[‖✗]/gu, '').replace(/\|\||\bx\b/gu, '').replace(/[▼v] /gu, 'M ').replace(/\s+/gu, ' ').trim());
    expect(words(listOf(coloured.rows))).toEqual(words(listOf(plain.rows)));
    // the marker column (two blanks) and the marker, dim
    expect(coloured.raw).toContain(`${ESC}[2m  ▼ 2 more`);
    expect(plain.raw).not.toContain('▼');
  }); // prettier-ignore
});

describe('the marker counts the TRUE total and says where the rest are only where `↓` cannot reach them', () => {
  it('rows the store counted but did not load: `▼ N more · /workflows, then [h]` (runs) and `· /resume` (sessions); loaded rows: only `▼ N more`', () => {
    const many: HomeSnapshot = { ...FIVE, totals: { attention: 32, sessions: 40, runs: 77 } };
    const list = listOf(frame({ snapshot: many, cols: 80, rows: 24 }).rows).map((row) =>
      row.trim(),
    );
    expect(list).toContain('v 28 more · /workflows, then [h]');
    expect(list).toContain('v 37 more · /resume');
    expect(list).toContain('v 74 more · /workflows, then [h]');
    // the rows shown + N = the total, section by section
    const attention = list.filter((row) => row.startsWith('||') || row.startsWith('x ')).length;
    expect(attention + 28).toBe(32);
    expect(list.filter((row) => row.startsWith('Session ')).length + 37).toBe(40);
    expect(list.filter((row) => row.startsWith('wf-r')).length + 74).toBe(77);
  });

  it('a window scrolled to the focus says `▲ N more` above it, and every row the keys reach is drawn when focused', () => {
    const rows = stripRows(PARKED, FIVE);
    for (let index = 0; index < rows.length; index += 1) {
      const list = listOf(frame({ cols: 80, rows: 24, focus: focusAt(rows, index) }).rows).map((row) => row.trim());
      expect(list.filter((row) => row.startsWith('> ')), `focus on ${String(index)}`).toHaveLength(1);
    }
    // the last session (five rows, three drawn): the window ends at the last row with only the `▲`
    const last = listOf(frame({ cols: 80, rows: 24, focus: focusAt(rows, 9) }).rows).map((row) => row.trim());
    expect(last).toContain('^ 2 more');
    expect(last).toContain('> Session 5 · chat · 50m ago · free');
    // the Attention rows are all drawn (five rows, the cap four, the fifth takes the marker's line): there is nothing above to count
    const attention = listOf(frame({ cols: 80, rows: 24, focus: focusAt(rows, 4) }).rows).map((row) => row.trim());
    expect(attention.some((row) => /^\^ \d+ more/u.test(row))).toBe(false);
    expect(attention.map(squash)).toContain('> x wf-f2 · failed 2h ago · $0.0400 · f2-0000-');
  }); // prettier-ignore

  it('the agents, which `↓` never reaches, say where they are when some are hidden', () => {
    const agents: HomeSnapshot = {
      ...FIVE,
      failedRuns: [],
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
  it('an unreadable run: `⚠ workflow · cannot be read · id`, its workflow only when the summary read named it', () => {
    const broken: HomeSnapshot = {
      ...FIVE,
      failedRuns: [],
      unreadableRuns: [
        { runId: 'u1000000-0000-4000-8000-000000000000', workflowSlug: 'nightly', reason: 'corrupt-row' },
        { runId: 'u2000000-0000-4000-8000-000000000000', reason: 'newer-version' },
      ],
      totals: { attention: 2, sessions: 5, runs: 5 },
    };
    const coloured = frame({ snapshot: broken, parked: [], cols: 100, rows: 30, color: true });
    const list = coloured.rows.map((row) => row.trim());
    expect(list).toContain('⚠ nightly · cannot be read · u1000000');
    expect(list).toContain('⚠ cannot be read · u2000000');
  }); // prettier-ignore

  it('no row of the page names a key: the hint row is the one place `Enter` is named', () => {
    const rows = stripRows(PARKED, FIVE);
    const { rows: drawn } = frame({ cols: 100, rows: 30, focus: focusAt(rows, 0) });
    const list = listOf(drawn);
    expect(list.join('\n')).not.toMatch(/Enter|↑\/↓|select/u);
    expect(drawn.at(-1)?.trim()).toBe('↑/↓ select · Enter open · type to chat · Esc start page');
  });
});

// ---- Round 2 (R2-W3a): 4/3/3 at 80×24, whitespace before words, no re-flow under the cursor, no section lost ------------------------

/** A world of `a` Attention items (up to three parked, the rest failed), `s` sessions and `r` runs, every row loaded. */
function worldOf(
  a: number,
  s: number,
  r: number,
): { snapshot: HomeSnapshot; parked: ParkedRunRow[] } {
  const parkedCount = Math.min(a, 3);
  return {
    parked: Array.from({ length: parkedCount }, (_, index) => parked(index + 1)),
    snapshot: {
      failedRuns: Array.from({ length: a - parkedCount }, (_, index) =>
        run(`f${String(index + 1)}`, 'failed', 60 + index),
      ),
      recentSessions: Array.from({ length: s }, (_, index) => session(index + 1)),
      recentRuns: Array.from({ length: r }, (_, index) =>
        run(`r${String(index + 1)}`, 'completed', 30 + index * 30),
      ),
      recentAgents: [],
      unreadableRuns: [],
      totals: { attention: a, sessions: s, runs: r },
      isEmpty: false,
    },
  };
}

const HEADINGS = ['Attention required', 'Continue', 'Sessions', 'Runs', 'Agents'] as const;

/** The item rows and the marker row of each section of a drawn list: the lines under a heading up to the next heading, blank rows not counted. */
function sectionsOf(
  list: readonly string[],
): Record<string, { items: number; marker: string | undefined }> {
  const found: Record<string, { items: number; marker: string | undefined }> = {};
  let current: string | undefined;
  for (const raw of list.map((row) => row.trim())) {
    if (raw === '') continue;
    if ((HEADINGS as readonly string[]).includes(raw)) {
      current = raw;
      if (raw !== 'Continue') found[raw] = { items: 0, marker: undefined };
      continue;
    }
    const section = current === undefined ? undefined : found[current];
    if (section === undefined) continue;
    if (/^[v^] \d+ more/u.test(raw)) section.marker = `${section.marker ?? ''}${raw}`;
    else section.items += 1;
  }
  return found;
}

describe('the maintainer’s numbers: 4 / 3 / 3 at 80×24 (R2-W3a, observation F1)', () => {
  const RICH = worldOf(12, 7, 8);

  it('80×24 with twelve Attention items, seven sessions and eight runs: Attention 4 and `▼ 8 more`, Sessions 3 and `▼ 4 more`, Runs 3 and `▼ 5 more`', () => {
    const { rows } = frame({ ...RICH, cols: 80, rows: 24 });
    const sections = sectionsOf(listOf(rows));
    expect(sections['Attention required']).toEqual({ items: 4, marker: 'v 8 more' });
    expect(sections['Sessions']).toEqual({ items: 3, marker: 'v 4 more' });
    expect(sections['Runs']).toEqual({ items: 3, marker: 'v 5 more' });
    expect(rows).toHaveLength(23);
  });

  it('whitespace gives way first: at 24 rows neither blank row (under the way back, above `Continue`), the Continue blank back at 25, both from 26', () => {
    const blanks = (terminalRows: number): { head: boolean; gap: boolean } => {
      const { rows } = frame({ ...RICH, cols: 80, rows: terminalRows });
      const text = rows.map((row) => row.trim());
      return { head: text[1] === '', gap: text[text.indexOf('Continue') - 1] === '' };
    };
    expect(blanks(24)).toEqual({ head: false, gap: false });
    expect(blanks(25)).toEqual({ head: false, gap: true });
    expect(blanks(26)).toEqual({ head: true, gap: true });
    // and the numbers are the same at the three sizes (the rows the blanks would have taken are not given to anything else)
    for (const terminalRows of [24, 25, 26]) {
      const sections = sectionsOf(listOf(frame({ ...RICH, cols: 80, rows: terminalRows }).rows));
      expect([
        sections['Attention required']?.items,
        sections['Sessions']?.items,
        sections['Runs']?.items,
      ]).toEqual([4, 3, 3]);
    }
  });
});

describe('no re-flow under the cursor (R2-W3a, observation F4)', () => {
  const RICH = worldOf(12, 7, 8);
  const strip = stripRows(RICH.parked, RICH.snapshot);
  /** The strip's section of row `index`: Attention first, then the sessions, then the runs. */
  const sectionOf = (index: number): string =>
    index < 12 ? 'Attention required' : index < 19 ? 'Sessions' : 'Runs';

  it.each([
    [80, 24],
    [100, 30],
  ] as const)('%i×%i: while `↓` walks inside one section no section takes more or fewer rows; the focused row is drawn once', (cols, rows) => {
    const shapes = new Map<string, Set<string>>();
    for (let index = 0; index < strip.length; index += 1) {
      const { rows: drawn } = frame({ ...RICH, cols, rows, focus: focusAt(strip, index) });
      const list = listOf(drawn);
      expect(list.filter((row) => row.trim().startsWith('> ')), `focus on ${String(index)}`).toHaveLength(1);
      const sections = sectionsOf(list);
      // the rows each section takes, markers included: its items and its markers (`▲` and `▼` each one row)
      const taken = ['Attention required', 'Sessions', 'Runs']
        .map((name) => {
          const section = sections[name];
          const markers = (section?.marker?.match(/[v^] \d+ more/gu) ?? []).length;
          return `${name}:${String((section?.items ?? 0) + markers)}`;
        })
        .join(' ');
      const group = sectionOf(index);
      shapes.set(group, (shapes.get(group) ?? new Set<string>()).add(taken));
    }
    for (const [group, seen] of shapes) expect([...seen], `the focus in ${group}`).toHaveLength(1);
  }); // prettier-ignore

  it('moving into Runs leaves the focused window two rows and its markers, not one row between a `▲` and a `▼` (rows are given back by the sections above)', () => {
    for (const [cols, rows] of [[80, 24], [100, 30]] as const)
      for (let index = 19; index < strip.length; index += 1) {
        const sections = sectionsOf(listOf(frame({ ...RICH, cols, rows, focus: focusAt(strip, index) }).rows));
        expect(sections['Runs']?.items, `${String(cols)}×${String(rows)} focus ${String(index)}`).toBeGreaterThanOrEqual(2);
      }
  }); // prettier-ignore
});

describe('no section with items is ever lost beside a notice and a long draft (R2-W3a, correctness F2)', () => {
  const lines = (count: number, prefix: string): string =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1)}`).join('\n');

  it.each([
    [80, 24],
    [100, 30],
  ] as const)('%i×%i: notices of 0, 1, 3 and 6 lines, drafts of 1, 5, 8 and 9 lines, the focus nowhere, on the first row and on the last: every heading is drawn and the focused row is marked', (cols, rows) => {
    for (const [a, s, r] of [[5, 5, 5], [12, 7, 8]] as const) {
      const { snapshot, parked: parkedRows } = worldOf(a, s, r);
      const strip = stripRows(parkedRows, snapshot);
      for (const notice of [0, 1, 3, 6])
        for (const draft of [1, 5, 8, 9])
          for (const focus of [undefined, focusAt(strip, 0), focusAt(strip, strip.length - 1)]) {
            const view = render(
              <HomeView
                page="work"
                snapshot={snapshot}
                parkedRuns={parkedRows}
                editor={{ text: lines(draft, 'd'), cursor: lines(draft, 'd').length }}
                nowMs={NOW}
                cols={cols}
                rows={rows}
                color={false}
                alternateScreen
                stripFocus={focus}
                notice={notice === 0 ? undefined : lines(notice, 'note ')}
              />,
            );
            const drawn = (view.lastFrame() ?? '').replace(SGR, '').split('\n');
            view.unmount();
            const label = `${String(cols)}×${String(rows)} (${String(a)},${String(s)},${String(r)}) notice ${String(notice)} draft ${String(draft)} focus ${focus?.id ?? 'none'}`;
            const text = drawn.join('\n');
            expect(text, label).toContain('Attention required');
            expect(text, label).toContain('Sessions');
            expect(text, label).toContain('Runs');
            // the frame is exactly rows − 1 tall, the hint row is the last, and the notice keeps the blank row above it
            expect(drawn.length, label).toBe(rows - 1);
            expect(drawn.at(-1), label).toContain('Esc start page');
            if (notice > 0) {
              const first = drawn.findIndex((row) => row.trim() === 'note 1');
              expect(first, label).toBeGreaterThan(0);
              expect(drawn[first - 1]?.trim(), label).toBe('');
            }
            if (focus !== undefined)
              expect(drawn.filter((row) => /^ *> (\|\||x |wf-|Session )/u.test(row)).length, label).toBe(1);
          }
    }
  }, 120_000); // prettier-ignore
});
