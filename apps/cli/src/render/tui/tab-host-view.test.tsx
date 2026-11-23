import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunDetailRecord, StepDetailRecord } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';

import { classifyActiveRuns } from '../../history/active-model.js';
import { buildDefinedModel, type DefinedEntry } from '../../history/defined-model.js';
import { buildHistoryRows } from '../../history/history-model.js';
import { buildNodeDetailModel } from '../../history/node-detail-model.js';
import { buildRunDetailModel } from '../../history/run-detail-model.js';
import type { RunDetailRead } from '../../history/run-detail-source.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type {
  PermissionsPort,
  PermissionsSnapshot,
  RepoAllowlist,
} from '../../permissions/chat-permissions.js';
import { bracketed, settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { initialPermissionsSheetState, type SheetMessage } from './permissions-sheet.js';
import {
  enterTab,
  freshTabMemory,
  withDefinedNote,
  type TabHostState,
  type TabId,
} from './tab-host.js';
import { openNodeTab } from './tab-host-node.js';
import { TabHostView } from './tab-host-view.js';

/**
 * The tab host as the terminal shows it ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, ADR-0122 §7): at 80×24 inside 23 rows, below the minimum with a stated hint, with colour on and with it off, in the inline and the
 * full-screen renderer through a mounted `RootApp` with real stdin bytes, and that a paste is dropped. `tab-host.test.ts` owns the model;
 * this file owns what is drawn from it and the wiring above it. The port and the clock are scripted: no operator home is read.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
/** Any foreground colour code (the regular and the bright palette). */
const ANY_COLOUR = new RegExp(`${ESC}\\[(3[0-7]|9[0-7])m`, 'u');
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');
const lineWith = (text: string, needle: string): string =>
  text.split('\n').find((line) => line.includes(needle)) ?? '';

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' },
      { id: 'b', label: 'node, 1 argument', remembered: '2026-11-18 09:30Z' },
    ],
  },
  session: undefined,
};
const ALLOWLIST: RepoAllowlist = {
  ok: true,
  commands: ['git status', 'npm test'],
  globs: ['git *'],
  omitted: 0,
};
/** The Defined tab over two workflows, `beta` pinned and one file that does not parse, plus a pin whose workflow left. */
const definedHost = (): TabHostState =>
  enterTab(freshTabMemory('defined'), 'defined', {
    port: undefined,
    now: 0,
    defined: {
      read: () => {
        const entries: readonly DefinedEntry[] = [
          { slug: 'alpha', name: 'Alpha', nodeCount: 3, path: 'a.yaml', valid: true },
          { slug: 'beta', name: undefined, nodeCount: 1, path: 'b.yaml', valid: true },
          {
            slug: 'torn',
            name: undefined,
            path: 't.yaml',
            valid: false,
            error: 'not a workflow',
          },
        ];
        return {
          model: buildDefinedModel({
            entries,
            pins: [
              { kind: 'workflow', ref: 'beta', rowid: 1, oversized: false },
              { kind: 'workflow', ref: 'gone', rowid: 2, oversized: false },
            ],
          }),
          slugOf: (index: number) => entries[index]?.slug,
          pathOf: (index: number) => entries[index]?.path,
        };
      },
    },
  });
const portOf = (snapshot: PermissionsSnapshot): PermissionsPort => ({
  surface: 'project',
  load: () => snapshot,
  withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
});

const hostOn = (tab: TabId, snapshot: PermissionsSnapshot = SNAPSHOT): TabHostState =>
  enterTab(freshTabMemory(tab), tab, { port: portOf(snapshot), now: 0 });
/** The Permissions tab with its sheet changed by `change`. */
const permissions = (
  change: (sheet: ReturnType<typeof initialPermissionsSheetState>) => object,
  snapshot: PermissionsSnapshot = SNAPSHOT,
): TabHostState => {
  const host = hostOn('permissions', snapshot);
  if (host.sheet === undefined) throw new Error('the Permissions tab holds no sheet');
  return { ...host, sheet: { ...host.sheet, ...change(host.sheet) } };
};

/** The frame with its style codes, as a terminal that has them draws it. */
const frame = (state: TabHostState, color: boolean, columns = 80, rows = 24): string =>
  render(<TabHostView state={state} color={color} columns={columns} rows={rows} />).lastFrame() ??
  '';
/** The frame without them: what a person without styling reads. */
const text = (state: TabHostState, columns = 80, rows = 24): string =>
  plain(frame(state, false, columns, rows));

describe('TabHostView at 80×24', () => {
  it.each(['defined', 'active', 'history', 'permissions'] as const)(
    '%s: draws within 23 rows, the strip first and the legend last, and never wider than the margin allows',
    (tab) => {
      const lines = text(hostOn(tab)).split('\n');
      expect(lines.length).toBeLessThanOrEqual(23);
      expect(lines[0]).toContain('▸ ');
      expect(lines[1]?.startsWith('───')).toBe(true);
      expect(lines.at(-1)).toContain('Esc close');
      for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(78);
    },
  );

  it('fits 23 rows with a long list and a long allowlist, the cursor kept in view', () => {
    const many: PermissionsSnapshot = {
      project: {
        ok: true,
        rows: Array.from({ length: 40 }, (_, i) => ({
          id: `g${String(i)}`,
          label: `tool${String(i)}, 1 argument`,
          remembered: '2026-11-19 12:00Z',
        })),
      },
      session: undefined,
      allowlist: {
        ok: true,
        commands: Array.from({ length: 30 }, (_, i) => `cmd-${String(i)}`),
        globs: ['a *', 'b *'],
        omitted: 20,
      },
    };
    const state = permissions((sheet) => ({ cursor: 25, snapshot: sheet.snapshot }), many);
    const lines = text(state).split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines.some((line) => line.startsWith('› tool25, 1 argument'))).toBe(true);
    expect(lines.join('\n')).toContain('more in the config');
  });

  it('says History cannot be read when nothing feeds it, in a word as well as a glyph', () => {
    const drawn = text(hostOn('history'));
    expect(drawn).toContain('▸ History');
    expect(drawn).toContain('The run history could not be read.');
  });
});

describe('TabHostView sanitizes at draw time', () => {
  it('draws no raw escape: a message row a tab handed in unsanitized reaches the terminal without its control sequence', () => {
    const noted = withDefinedNote(definedHost(), `before${ESC}[2Jafter${String.fromCharCode(7)}`);
    expect(noted.defined?.message, 'the model really holds the raw text').toContain(ESC);
    // `plain` takes off the view's own style codes (`ESC[…m`): an escape left after it is the message's.
    const drawn = plain(frame(noted, false));
    expect(drawn).not.toContain(ESC);
    expect(drawn).not.toContain(String.fromCharCode(7));
    expect(drawn).toContain('beforeafter');
  });

  it('leaves a line it has nothing to remove from exactly as the model drew it', () => {
    const drawn = text(definedHost());
    expect(drawn).toContain('› beta');
    expect(drawn).toContain('★ pinned');
  });
});

describe('TabHostView on the Defined tab', () => {
  it('draws every row with a glyph and a word, in 23 rows, with no colour at all when colour is off', () => {
    const styled = frame(definedHost(), false);
    expect(styled).not.toMatch(ANY_COLOUR);
    const drawn = plain(styled);
    const lines = drawn.split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines[0]).toContain('▸ Defined');
    for (const word of [
      '★ pinned',
      '· unpinned',
      '? not in catalog',
      '✗ invalid',
      '3 nodes',
      '1 node',
    ])
      expect(drawn, word).toContain(word);
    expect(lines.filter((line) => line.startsWith('› ')).length, 'one selected row').toBe(1);
    expect(lines.at(-1)).toContain('↑/↓ select · [r] run · [x] export · [p] pin · Esc close');
  });

  it('draws the selected row in cyan, a quiet tail dimmed, and the key of an action in its own style', () => {
    const drawn = frame(definedHost(), true);
    expect(lineWith(drawn, '› beta')).toContain(CYAN);
    expect(lineWith(drawn, 'alpha')).toContain(DIM);
    expect(lineWith(drawn, 'Tab'), 'the legend: the keys apart from the words').toContain(
      `${BOLD}[r]`,
    );
  });
});

/** The History tab over three finished runs (one pinned, one whose log is unreadable) and a pin whose run is gone. */
const historyHost = (): TabHostState => {
  const at = '2026-11-23T10:00:00.000Z';
  const run = (id: string, status: 'completed' | 'failed' | 'cancelled') => ({
    id,
    workflowId: 'wf',
    status,
    executionMode: 'local' as const,
    triggerType: 'manual',
    startedAt: at,
    completedAt: at,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
  });
  const rows = buildHistoryRows({
    runs: [
      run('aaaaaaaa-0000', 'completed'),
      run('bbbbbbbb-0000', 'failed'),
      run('cccccccc-0000', 'cancelled'),
    ],
    nowMs: Date.parse(at) + 3_600_000,
    pinnedRunIds: new Set(['aaaaaaaa-0000']),
    workflowLabels: new Map([['wf', 'deploy']]),
  });
  return enterTab(freshTabMemory('history'), 'history', {
    port: undefined,
    now: 0,
    history: {
      read: () => ({
        query: { scope: 'project', status: undefined, page: 0 },
        pinned: [{ kind: 'missing', label: 'gone-run', pinRowid: 9 }],
        rows: rows.map((row) => ({
          kind: 'run' as const,
          row,
          ...(row.pinned ? { pinRowid: 1 } : {}),
        })),
        hasPrev: false,
        hasNext: false,
      }),
      cost: (row) =>
        row.status === 'failed' ? { kind: 'unreadable' } : { kind: 'text', text: '$0.0123' },
      loadDetail: () => Promise.resolve({ kind: 'missing' }),
    },
  });
};

describe('TabHostView on the History tab', () => {
  it('draws every row with a glyph and a word, in 23 rows, with no colour at all when colour is off', () => {
    const styled = frame(historyHost(), false);
    expect(styled).not.toMatch(ANY_COLOUR);
    const lines = plain(styled).split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    const drawn = lines.join('\n');
    for (const word of [
      '✓ completed',
      '? unreadable',
      '⊘ cancelled',
      '? missing',
      '★ pinned',
      '$0.0123',
      'Pinned (1)',
      'this project · every finished run · page 1 (last)',
    ])
      expect(drawn, word).toContain(word);
    expect(lines.filter((line) => line.startsWith('› ')).length, 'one selected row').toBe(1);
    expect(lines.at(-1)).toBe(
      '←/→ tab · ↑/↓ move · Enter open · [p] pin · [a] all · [f] filter · Esc close',
    );
  });

  it('draws the selected row in cyan, a quiet tail dimmed, and the key of an action in its own style', () => {
    const drawn = frame(historyHost(), true);
    expect(lineWith(drawn, '› ? missing')).toContain(CYAN);
    expect(lineWith(drawn, '⊘ cancelled')).toContain(DIM);
    expect(lineWith(drawn, '[p]'), 'the legend: the keys apart from the words').toContain(
      `${BOLD}[p]`,
    );
  });
});

/** The Active tab over one run of each kind that has its own glyph: this Home's own, a paused gate, a stalled run and a held one. */
const activeHost = (): TabHostState => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const base = {
    workflowId: 'wf',
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    projectRoot: '/work/here',
    updatedAt: new Date(now - 1_000).toISOString(),
  } as const;
  const young = new Date(now - 5_000).toISOString();
  const old = new Date(now - 300_000).toISOString();
  const rows = classifyActiveRuns({
    runs: [
      { ...base, id: 'hostrun1', status: 'running', createdAt: young },
      { ...base, id: 'gaterun1', status: 'paused', createdAt: young },
      { ...base, id: 'stallrun', status: 'running', createdAt: old },
      { ...base, id: 'heldrun1', status: 'running', createdAt: young },
    ],
    leases: new Map(),
    hostedRunId: 'hostrun1',
    currentProjectRoot: '/work/here',
    outboxHeldRunIds: new Set(['heldrun1']),
    nowMs: now,
    leaseTtlMs: 60_000,
    pendingGateCounts: new Map([['gaterun1', 1]]),
  });
  return enterTab(freshTabMemory('active'), 'active', {
    port: undefined,
    now: 0,
    active: {
      last: { rows, more: [{ status: 'paused', count: 3, atLeast: false }], heldUnread: false },
    },
  });
};

describe('TabHostView on the Active tab', () => {
  it('draws every class with a glyph and a word, the "N more" row and the legend, in 23 rows, with no colour at all when colour is off', () => {
    const styled = frame(activeHost(), false);
    expect(styled).not.toMatch(ANY_COLOUR);
    const drawn = plain(styled);
    const lines = drawn.split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines[0]).toContain('▸ Active');
    for (const word of [
      '◐ running',
      '⏸ paused',
      '⚠ stalled',
      '◇ held',
      '… 3 more paused not listed',
    ])
      expect(drawn, word).toContain(word);
    expect(lines.filter((line) => line.startsWith('› ')).length, 'one selected row').toBe(1);
    expect(lines.at(-1)).toContain('↑/↓ select · Enter open · Esc close');
  });

  it('draws the selected row in cyan, a quiet reason dimmed, and the word of a stalled or held run in attention', () => {
    const drawn = frame(activeHost(), true);
    expect(lineWith(drawn, '› ')).toContain(CYAN);
    expect(lineWith(drawn, 'gaterun1')).toContain(DIM);
    expect(lineWith(drawn, 'stallrun')).toContain(YELLOW);
    expect(lineWith(drawn, 'heldrun1')).toContain(YELLOW);
  });
});

/** The History tab with the node page of a failed node open over its run's detail: an error, a masked output, a tool trace, a timeline. */
const nodeHost = (): TabHostState => {
  const at = '2026-11-23T10:00:00.000Z';
  const base = { runId: 'cccccccc-0000', timestamp: at };
  const run: RunDetailRecord = {
    id: 'cccccccc-0000',
    workflowId: 'wf',
    status: 'failed',
    executionMode: 'local',
    triggerType: 'manual',
    startedAt: at,
    completedAt: at,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
    outputJson: null,
    outputByteLength: null,
    errorJson: null,
    errorByteLength: null,
  };
  const detail: StepDetailRecord = {
    nodeId: 'review',
    nodeType: 'agent',
    status: 'failed',
    attemptNumber: 1,
    durationMs: 1200,
    costMicrocents: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    outputJson: JSON.stringify({ note: `key sk-ant-api03-${'A'.repeat(40)}` }),
    outputByteLength: 1,
    errorJson: JSON.stringify({ code: 'tool_failed', message: 'The review found a problem.' }),
    errorByteLength: 1,
  };
  const events: RunEvent[] = [
    { type: 'node:started', ...base, sequenceNumber: 1, nodeId: 'review', nodeType: 'agent' },
    {
      type: 'node:failed',
      ...base,
      sequenceNumber: 2,
      nodeId: 'review',
      error: { code: 'tool_failed', message: 'The review found a problem.', retryable: false },
      toolActivity: [{ toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 12 }],
    },
  ];
  const model = buildRunDetailModel({ run, steps: [detail], events, workflowSlug: 'deploy' });
  const row = model.rows[0];
  if (row === undefined) throw new Error('the run has a node');
  const read: RunDetailRead = {
    runId: run.id,
    status: 'failed',
    model,
    terminalHeld: false,
    heldUnread: false,
    events: [],
    eventsComplete: true,
    skippedRows: 0,
  };
  const node = openNodeTab(run.id, row, {
    kind: 'ready',
    detail: {
      runId: run.id,
      nodeId: 'review',
      model: buildNodeDetailModel({ detail, attempts: [detail], events, runFinished: true }),
      position: { index: 3, of: 4 },
      authoredType: 'agent',
      attemptNumbers: [1],
      eventsComplete: true,
    },
  });
  const list = historyHost();
  if (list.history === undefined) throw new Error('the History tab was read');
  return {
    ...list,
    history: { ...list.history, detail: { runId: run.id, phase: 'ready', read, cursor: 0, node } },
  };
};

describe('TabHostView on the node page', () => {
  it('draws the node with a glyph and a word, its order, error and masked output, in 23 rows, with no colour at all when colour is off', () => {
    const styled = frame(nodeHost(), false);
    expect(styled).not.toMatch(ANY_COLOUR);
    const lines = plain(styled).split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines[0]).toContain('▸ History');
    const drawn = lines.join('\n');
    for (const word of [
      '✗ failed  review',
      'Order in the workflow: 3 of 4  ·  type agent',
      'Error (attempt 1)',
      'The review found a problem.',
      'read_file',
      'ok in 12ms',
      'masked',
    ])
      expect(drawn, word).toContain(word);
    expect(drawn).not.toContain('sk-ant-api03');
    expect(lines.filter((line) => line.startsWith('› ')).length, 'one selected line').toBe(1);
    expect(lines.at(-1)).toBe('←/→ tab · Tab cycle · ↑/↓ scroll · [n] first failed · Esc back');
  });

  it('draws the heading bold, the error in red and the key of the action in its own style when colour is on', () => {
    const drawn = frame(nodeHost(), true);
    expect(lineWith(drawn, '✗ failed  review')).toContain(CYAN);
    expect(lineWith(drawn, 'tool_failed')).toContain(RED);
    expect(lineWith(drawn, '[n]'), 'the legend: the keys apart from the words').toContain(
      `${BOLD}[n]`,
    );
  });

  it('is the enlarge line below 80×24, and the page again when the terminal is back', () => {
    expect(text(nodeHost(), 79, 24)).toContain('Enlarge the terminal');
    expect(text(nodeHost(), 80, 23)).toContain('Enlarge the terminal');
    expect(text(nodeHost(), 80, 24)).toContain('Order in the workflow');
  });
});

describe('TabHostView below the minimum', () => {
  it.each([
    [79, 24],
    [80, 23],
    [60, 20],
  ])(
    'at %i×%i it says to enlarge, names the way out, and draws nothing of the screen',
    (columns, rows) => {
      expect(text(hostOn('permissions'), columns, rows).split('\n')).toEqual([
        'Enlarge the terminal — Esc steps back, or closes at the list.',
        'Esc close',
      ]);
    },
  );
});

describe('TabHostView with colour on', () => {
  it('draws the current tab bold and the others dim, the rule dim, the selected row cyan with its key in red, and the allowlist heading bold', () => {
    const drawn = frame(hostOn('permissions', { ...SNAPSHOT, allowlist: ALLOWLIST }), true);
    const strip = lineWith(drawn, '▸ Permissions');
    expect(strip).toContain(`${BOLD}▸ Permissions`);
    expect(strip).toContain(`${DIM}Defined`);
    expect(lineWith(drawn, '────').startsWith(DIM)).toBe(true);
    const selected = lineWith(drawn, '› npm, 1 argument');
    expect(selected).toContain(CYAN);
    expect(selected).toMatch(new RegExp(`${ESC}\\[31m\\[d\\]`, 'u'));
    expect(lineWith(drawn, 'This repository · allowlist')).toContain(BOLD);
    expect(lineWith(drawn, 'git status'), 'the word that says what it is, dimmed').toContain(
      `${DIM}  command`,
    );
    expect(lineWith(drawn, 'Tab'), 'the legend: the keys apart from the words').toContain(
      `${BOLD}←/→`,
    );
  });

  it('draws a withdrawal’s answer by its tone: done in green with a tick, a failure in red with a cross, a note in yellow', () => {
    const answer = (message: SheetMessage): string =>
      frame(
        permissions(() => ({ message })),
        true,
      );
    expect(lineWith(answer({ tone: 'done', text: 'Withdrawn.' }), '✓')).toContain(GREEN);
    expect(lineWith(answer({ tone: 'failed', text: 'No room.' }), '✗')).toContain(RED);
    expect(lineWith(answer({ tone: 'note', text: 'Already gone.' }), 'Already gone.')).toContain(
      YELLOW,
    );
  });

  it('draws a placeholder’s unreadable sentence in red', () => {
    const state: TabHostState = { ...hostOn('permissions'), sheet: undefined, unreadable: true };
    expect(lineWith(frame(state, true), 'Could not read the permissions.')).toContain(RED);
  });
});

describe('TabHostView with colour off (NO_COLOR)', () => {
  it('emits no colour at all, and a glyph and a word still tell every state', () => {
    const states: readonly (readonly [string, TabHostState, readonly string[]])[] = [
      ['the current tab', hostOn('permissions'), ['▸ Permissions']],
      ['a selected row', hostOn('permissions'), ['› npm, 1 argument', '[d] withdraw']],
      [
        'a waiting question',
        permissions(() => ({ armed: true })),
        [
          '[Enter] withdraw',
          'Withdraw npm, 1 argument (2026-11-19 12:00Z)? Any other key keeps it.',
          '[Enter] withdraw · Esc keep',
        ],
      ],
      [
        'a done answer',
        permissions(() => ({ message: { tone: 'done', text: 'Withdrawn.' } })),
        ['✓ Withdrawn.'],
      ],
      [
        'a failed answer',
        permissions(() => ({ message: { tone: 'failed', text: 'No room.' } })),
        ['✗ No room.'],
      ],
      [
        'a note',
        permissions(() => ({ message: { tone: 'note', text: 'Already gone.' } })),
        ['Already gone.'],
      ],
      [
        'rows above and below the window',
        permissions(() => ({ cursor: 14 }), {
          project: {
            ok: true,
            rows: Array.from({ length: 40 }, (_, i) => ({
              id: `g${String(i)}`,
              label: `tool${String(i)}, 1 argument`,
              remembered: '2026-11-19 12:00Z',
            })),
          },
          session: undefined,
        }),
        ['▲ ', ' more', '▼ '],
      ],
      [
        'an unreadable tab',
        { ...hostOn('permissions'), sheet: undefined, unreadable: true },
        ['Could not read the permissions.'],
      ],
      [
        'an unreadable History tab',
        hostOn('history'),
        ['▸ History', 'The run history could not be read.'],
      ],
      [
        'the allowlist',
        hostOn('permissions', { ...SNAPSHOT, allowlist: ALLOWLIST }),
        [
          'This repository · allowlist, read-only (2 commands, 1 pattern)',
          'command git status',
          'pattern git *',
        ],
      ],
      [
        'an allowlist that could not be read',
        hostOn('permissions', {
          ...SNAPSHOT,
          allowlist: { ok: false, text: 'The repository’s [chat] allowlist could not be read.' },
        }),
        ['The repository’s [chat] allowlist could not be read.'],
      ],
    ];
    for (const [name, state, words] of states) {
      const styled = frame(state, false);
      expect(styled, name).not.toMatch(ANY_COLOUR);
      for (const word of words) expect(plain(styled), `${name}: ${word}`).toContain(word);
    }
  });
});

// ---- Through a mounted RootApp ----------------------------------------------------------------------------------------------

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

/** The Home with its tab host open on Permissions, mounted in the inline renderer or (`alternateScreen`) the full-screen one. */
function mountTabHost(
  options: { alternateScreen?: boolean; size?: { cols: number; rows: number } } = {},
) {
  const size = options.size ?? { cols: 80, rows: 24 };
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    permissions: portOf({ ...SNAPSHOT, allowlist: ALLOWLIST }),
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  expect(controller.openScreen('tab-host', { tab: 'permissions' })).toBe(true);
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
      {...(options.alternateScreen === true ? { alternateScreen: true } : {})}
    />,
  );
  // `force-color.js` makes chalk emit its codes under vitest, so the frame is read without them: what a person without styling reads.
  return { controller, harness, frame: (): string => plain(harness.lastFrame() ?? '') };
}

/** Poll until `predicate` holds and FAIL if it never does (a bare wait that gives up quietly would assert nothing). */
const until = (predicate: () => boolean, timeout = 3000): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate())
        throw new Error(`the condition did not become true: ${predicate.toString()}`);
    },
    { timeout, interval: 15 },
  );

describe.each([
  ['the inline renderer', false],
  ['the full-screen renderer', true],
] as const)('RootApp in %s', (_name, alternateScreen) => {
  it('draws the tab host in place of the landing at 80×24, in at most 23 rows, with no prompt and no strip', async () => {
    const m = mountTabHost({ alternateScreen });
    await until(() => m.frame().includes('▸ Permissions'));
    const lines = m.frame().split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(m.frame()).toContain('This project · remembered (2)');
    expect(m.frame()).toContain(
      '←/→ tab · Tab cycle · ↑/↓ select · [d / Del] withdraw · Esc close',
    );
    expect(m.frame(), 'no prompt behind the screen').not.toContain('/ for commands');
  });

  it('moves between tabs with the keys a person presses, and Esc leaves for the landing', async () => {
    const m = mountTabHost({ alternateScreen });
    await until(() => m.frame().includes('▸ Permissions'));
    m.harness.stdin.write(`${ESC}[D`); // ←
    await until(() => m.frame().includes('▸ History'));
    expect(m.frame()).toContain('The run history could not be read.');
    m.harness.stdin.write('\t');
    await until(() => m.frame().includes('▸ Permissions'));
    m.harness.stdin.write(ESC);
    await until(() => m.controller.getSnapshot().screen === undefined);
    await until(() => m.frame().includes('/ for commands'));
  });

  it('drops a paste: it reaches neither the screen nor the prompt behind it', async () => {
    const m = mountTabHost({ alternateScreen });
    await until(() => m.frame().includes('▸ Permissions'));
    const before = m.frame();
    m.harness.stdin.write(bracketed('hello world'));
    await settleFrames();
    expect(m.controller.getSnapshot().input.text).toBe('');
    expect(m.frame(), 'nothing of it is drawn').not.toContain('hello');
    expect(m.frame()).toBe(before);
    expect(m.controller.getSnapshot().screen?.kind).toBe('tab-host');
  });

  it('below 80×24 draws the one-line hint and takes only Esc and Ctrl+C', async () => {
    const m = mountTabHost({ alternateScreen, size: { cols: 70, rows: 20 } });
    await until(() => m.frame().includes('Enlarge the terminal'));
    expect(m.frame().split('\n')).toEqual([
      'Enlarge the terminal — Esc steps back, or closes at the list.',
      'Esc close',
    ]);
    m.harness.stdin.write(`${ESC}[D`);
    await settleFrames();
    const screen = m.controller.getSnapshot().screen;
    expect(
      screen?.kind === 'tab-host' ? screen.host.tab : undefined,
      'a tab key is not delivered',
    ).toBe('permissions');
    m.harness.stdin.write('\u0003');
    await until(() => m.controller.getSnapshot().screen === undefined);
  });
});
