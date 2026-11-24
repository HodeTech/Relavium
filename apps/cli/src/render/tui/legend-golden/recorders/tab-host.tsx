import { plainRows, styledRows } from '../frames.js';

import type { ReactElement } from 'react';

import type { RunDetailRecord, RunSummaryRecord, StepSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { classifyActiveRuns, type ActiveRow } from '../../../../history/active-model.js';
import type { ActiveRead } from '../../../../history/active-source.js';
import { buildAgentsModel, type AgentsModelItem } from '../../../../history/agents-model.js';
import {
  buildDefinedModel,
  type DefinedEntry,
  type DefinedPin,
} from '../../../../history/defined-model.js';
import { buildHistoryRows } from '../../../../history/history-model.js';
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryRead,
} from '../../../../history/history-source.js';
import type { NodeDetailLoad, NodeDetailRead } from '../../../../history/node-detail-source.js';
import { buildNodeDetailModel } from '../../../../history/node-detail-model.js';
import { buildRunDetailModel } from '../../../../history/run-detail-model.js';
import type { RunDetailLoad, RunDetailRead } from '../../../../history/run-detail-source.js';
import type { AgentsPort } from '../../../../home/agents-port.js';
import type {
  PermissionsPort,
  PermissionsSnapshot,
} from '../../../../permissions/chat-permissions.js';
import type { ChatKey } from '../../chat-input.js';
import { keyLabel, legend, type LegendItem } from '../../legend.js';
import {
  initialPermissionsSheetState,
  SHEET_SETTLE_MS,
  type PermissionsSheetState,
} from '../../permissions-sheet.js';
import { PermissionsSheetView } from '../../permissions-sheet-view.js';
import type { SheetGeometry, SheetLine } from '../../sheet-frame.js';
import { usableColumns } from '../../sheet-frame.js';
import { ACTIVE_KEYS, ACTIVE_FOCUS_LEFT, ACTIVE_SELECT_FIRST } from '../../tab-host-active.js';
import { AGENTS_KEYS } from '../../tab-host-agents.js';
import {
  HISTORY_COST_FAULT,
  HISTORY_DETAIL_FAULT,
  HISTORY_DETAIL_MISSING,
  HISTORY_DETAIL_UNREADABLE,
  HISTORY_EMPTY_PAGE,
  HISTORY_HINT,
  HISTORY_HINT_MORE,
  HISTORY_KEYS,
  HISTORY_MISSING_RUN,
  HISTORY_UNREADABLE,
  type HistoryPort,
} from '../../tab-host-history.js';
import { NODE_KEYS, NODE_NOT_A_NODE, type NodeLoader } from '../../tab-host-node.js';
import { PIN_KEY } from '../../tab-host-pin.js';
import {
  SESSIONS_KEYS,
  SESSIONS_RESUME_UNAVAILABLE,
  type SessionRow,
  type SessionsPort,
} from '../../tab-host-sessions.js';
import {
  DEFINED_KEYS,
  DEFINED_NO_DETAIL,
  type DefinedPort,
  type DefinedRead,
} from '../../tab-host-workflows.js';
import {
  enterHistoryAtDetail,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegend,
  tabHostLines,
  TAB_HOST_KEYS,
  TAB_HOST_LEGEND_PLAIN_ITEMS,
  TAB_HOST_LEGEND_ROWS_ITEMS,
  TAB_HOST_TOO_SMALL,
  withActiveFailure,
  withActiveNote,
  withActiveRead,
  withHistoryLoad,
  withHistoryLoadFailure,
  type TabHostContext,
  type TabHostState,
} from '../../tab-host.js';
import { TabHostView } from '../../tab-host-view.js';
import { displayWidth } from '../../viewport.js';
import type { Producer, Recorder, StateRows } from '../golden.js';
import { isHintShaped } from '../hint-shape.js';
import {
  BELOW_FLOOR,
  bySize,
  footRows,
  GEOMETRIES,
  lineOfKind,
  rolesOf,
  type FootOptions,
  type NamedSize,
} from './sheets.js';

/**
 * The Home's tab host: the strip's legend (what it names by tab and by state, and the `Ctrl+C close` item that is named only where the
 * legend fits the 80-column floor), the hint below the floor, and each tab's own legend and sentences that name a key. Every state is
 * built through the modules' own constructors and reducers (`enterTab`, `foldTabHostKey`, `withActiveRead`, ...), and what is recorded
 * is what `tabHostLines` draws, so the clipping to the sheet width is part of the golden.
 */

// ---- The scene --------------------------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const NOW = T0 + 3 * 3_600_000;
/** The monotonic clock a tab is entered at, and the one a key is pressed at (the sheet has settled by then). */
const OPENED = 10_000;
const SETTLED = OPENED + SHEET_SETTLE_MS + 600;

const DOWN: ChatKey = { downArrow: true };
const ENTER: ChatKey = { return: true };

const context = (over: Partial<TabHostContext> = {}): TabHostContext => ({
  port: undefined,
  now: OPENED,
  canArm: true,
  ...over,
});

/** The state a key leaves the tab host in; a key that closes the screen is not one a recorder presses. */
function pressed(
  state: TabHostState,
  input: string,
  key: ChatKey,
  over: Partial<TabHostContext> = {},
): TabHostState {
  const step = foldTabHostKey(state, input, key, context(over));
  if (step.kind === 'close') throw new Error(`the key ${JSON.stringify(input)} closed the screen`);
  return step.state;
}

/** `state` after `count` presses of `key`. */
function repeat(
  state: TabHostState,
  count: number,
  key: ChatKey,
  over: Partial<TabHostContext> = {},
): TabHostState {
  let next = state;
  for (let index = 0; index < count; index += 1) next = pressed(next, '', key, over);
  return next;
}

/** One state to record: a label, the tab host as it stands and which lines of its foot to take. */
interface Case {
  readonly name: string;
  readonly state: TabHostState;
  readonly foot?: FootOptions;
}

/** The foot of every case at both sizes (`<name> cols=80,100` where they say the same, else `cols=80` and `cols=100`). */
function footStates(cases: readonly Case[]): StateRows {
  const out: Record<string, readonly string[]> = {};
  for (const { name, state, foot } of cases)
    Object.assign(
      out,
      bySize(name, (geometry) => footRows(tabHostLines(state, geometry), foot)),
    );
  return out;
}

/** The legend line of a state at the floor, as the tab host draws it. */
function legendLineOf(
  state: TabHostState,
  geometry: SheetGeometry = GEOMETRIES[0].geometry,
): SheetLine | undefined {
  return lineOfKind(tabHostLines(state, geometry), 'legend');
}

// ---- The Permissions tab ----------------------------------------------------------------------------------------------------

function grants(count: number): PermissionsSnapshot['project'] {
  return {
    ok: true,
    rows: Array.from({ length: count }, (_, index) => ({
      id: `g${String(index)}`,
      label: `tool${String(index)}, 1 argument`,
      remembered: '2026-11-19 12:00Z',
    })),
  };
}

function permissionsPort(count: number): PermissionsPort {
  const snapshot: PermissionsSnapshot = { project: grants(count), session: undefined };
  return {
    surface: 'project',
    load: () => snapshot,
    withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
  };
}

const unreadablePort: PermissionsPort = {
  surface: 'project',
  load: () => {
    throw new Error('the store could not be read');
  },
  withdraw: () => ({ tone: 'failed', text: 'Nothing changed.' }),
};

function permissionsHost(port: PermissionsPort | undefined): TabHostState {
  return enterTab(freshTabMemory('permissions'), 'permissions', { port, now: OPENED });
}

function permissionsCases(): readonly Case[] {
  const port = permissionsPort(3);
  const idle = permissionsHost(port);
  const armed = pressed(idle, 'd', {}, { port, now: SETTLED });
  const typed = pressed(idle, 'x', {}, { port, now: SETTLED });
  const tooEarly = pressed(typed, 'd', {}, { port, now: SETTLED });
  return [
    { name: 'tab=permissions rows=3 state=idle', state: idle },
    { name: 'tab=permissions rows=3 state=armed', state: armed },
    { name: 'tab=permissions rows=3 note=typed keys', state: tooEarly },
    { name: 'tab=permissions rows=0', state: permissionsHost(permissionsPort(0)) },
    { name: 'tab=permissions unreadable=port throws', state: permissionsHost(unreadablePort) },
    { name: 'tab=permissions unreadable=no port', state: permissionsHost(undefined) },
  ];
}

// ---- The Defined tab --------------------------------------------------------------------------------------------------------

const entry = (slug: string, over: Partial<DefinedEntry> = {}): DefinedEntry => ({
  slug,
  name: undefined,
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: true,
  ...over,
});

const READY_ENTRIES: readonly DefinedEntry[] = [
  entry('code-review', { name: 'Code Review', nodeCount: 5 }),
  entry('nightly', { nodeCount: 1 }),
  entry('broken-one', { valid: false, error: 'a workflow must declare at least one node' }),
];

function definedPort(
  entries: readonly DefinedEntry[],
  pins: readonly DefinedPin[] = [],
  otherRoot?: string,
): DefinedPort {
  return {
    read: (): DefinedRead => ({
      model: buildDefinedModel({
        entries,
        pins,
        ...(otherRoot === undefined
          ? {}
          : {
              otherPins: [
                {
                  kind: 'workflow',
                  ref: 'elsewhere',
                  rowid: 9,
                  oversized: false,
                  projectRoot: otherRoot,
                },
              ],
            }),
        lastRuns: new Map<string, RunStatus>([['code-review', 'completed']]),
      }),
      slugOf: (index) => entries[index]?.slug,
      pathOf: (index) => entries[index]?.path,
    }),
  };
}

const workflowPin = (ref: string, rowid: number): DefinedPin => ({
  kind: 'workflow',
  ref,
  rowid,
  oversized: false,
});

function definedHost(port: DefinedPort | undefined): TabHostState {
  return enterTab(freshTabMemory('defined'), 'defined', {
    port: undefined,
    defined: port,
    now: OPENED,
  });
}

function definedCases(): readonly Case[] {
  const rows = definedHost(definedPort(READY_ENTRIES));
  const pins = [workflowPin('left-the-catalog', 8), workflowPin('code-review', 7)];
  const withPins = definedHost(definedPort(READY_ENTRIES, pins, '/work/other-project'));
  // The rows with pins: this project's pins first (the newest pin first), the pin of another project after them, then the rest of the catalog.
  const sentence: FootOptions = { kinds: ['text', 'legend'] };
  return [
    { name: 'tab=defined rows=3 row=ready', state: rows, foot: { kinds: ['legend'] } },
    { name: 'tab=defined rows=3 row=invalid', state: repeat(rows, 2, DOWN), foot: sentence },
    {
      name: 'tab=defined rows=3 key=Enter',
      state: pressed(rows, '', ENTER),
      foot: { kinds: ['notice', 'legend'] },
    },
    {
      name: 'tab=defined pins row=pinned in the catalog',
      state: repeat(withPins, 1, DOWN),
      foot: sentence,
    },
    { name: 'tab=defined pins row=pinned, not in catalog', state: withPins, foot: sentence },
    {
      name: 'tab=defined pins row=other project',
      state: repeat(withPins, 2, DOWN),
      foot: sentence,
    },
    {
      name: 'tab=defined pins row=other project, root not recorded',
      state: repeat(definedHost(definedPort(READY_ENTRIES, pins, '')), 2, DOWN),
      foot: sentence,
    },
    { name: 'tab=defined rows=0', state: definedHost(definedPort([])), foot: sentence },
    {
      name: 'tab=defined unreadable=no port',
      state: definedHost(undefined),
      foot: { kinds: ['legend'] },
    },
  ];
}

// ---- The Active tab ---------------------------------------------------------------------------------------------------------

const HERE = '/work/here';
const THERE = '/work/there';
const TTL = 60_000;

/** A run of this project (`HERE`), or of the directory named by `projectRoot`, or of none when that is `null`. */
function run(
  id: string,
  status: RunStatus,
  over: Partial<RunSummaryRecord> = {},
  projectRoot: string | null = HERE,
): RunSummaryRecord {
  return {
    id,
    workflowId: 'wf',
    status,
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: new Date(NOW - 5_000).toISOString(),
    updatedAt: new Date(NOW - 5_000).toISOString(),
    ...(projectRoot === null ? {} : { projectRoot }),
    ...over,
  };
}

const IDS = {
  hosted: 'hostrun1',
  other: 'otherrun',
  pending: 'pendrun1',
  gate: 'gaterun1',
  media: 'mediarun',
  mediaDone: 'mediaold',
  unknown: 'unknownr',
  elsewhere: 'elserun1',
  nowhere: 'nowhere1',
  stalled: 'stallrun',
  held: 'heldrun1',
} as const;

/** Every class of run the tab draws, classified by the model itself. */
const EVERY_CLASS: readonly ActiveRow[] = classifyActiveRuns({
  runs: [
    run(IDS.hosted, 'running'),
    run(IDS.other, 'running'),
    run(IDS.pending, 'pending'),
    run(IDS.gate, 'paused'),
    run(IDS.media, 'paused'),
    run(IDS.mediaDone, 'paused'),
    run(IDS.unknown, 'paused'),
    run(IDS.elsewhere, 'paused', {}, THERE),
    run(IDS.nowhere, 'paused', {}, null),
    run(IDS.stalled, 'running', { createdAt: new Date(NOW - 5 * TTL).toISOString() }),
    run(IDS.held, 'running'),
  ],
  leases: new Map(),
  hostedRunId: IDS.hosted,
  currentProjectRoot: HERE,
  outboxHeldRunIds: new Set([IDS.held]),
  nowMs: NOW,
  leaseTtlMs: TTL,
  pendingGateCounts: new Map([
    [IDS.gate, 1],
    [IDS.media, 0],
    [IDS.mediaDone, 0],
  ]),
  pendingMediaJobCounts: new Map([[IDS.media, 1]]),
});

const activeRead = (rows: readonly ActiveRow[], over: Partial<ActiveRead> = {}): ActiveRead => ({
  rows,
  more: [],
  heldUnread: false,
  ...over,
});

/** The Active tab entered on the last read the host kept, the cursor on `focus` (a run id) when it is listed. */
function activeHost(last: ActiveRead | undefined, focus?: string): TabHostState {
  return enterTab(
    { ...freshTabMemory('active'), ...(focus === undefined ? {} : { activeFocus: focus }) },
    'active',
    { port: undefined, active: { last }, now: OPENED },
  );
}

function activeCases(): readonly Case[] {
  const everything = activeRead(EVERY_CLASS);
  const row = (name: string, id: string): Case => ({
    name: `tab=active ${name}`,
    state: activeHost(everything, id),
    foot: { kinds: ['text', 'legend'] },
  });
  const focused = activeHost(everything, IDS.gate);
  // The focused run leaves the list: the cursor stays inside the rows and the tab says so; `Enter` then asks for a selection first.
  const left = withActiveRead(
    focused,
    activeRead(EVERY_CLASS.filter((candidate) => candidate.runId !== IDS.gate)),
  );
  return [
    row('row=hosted leg', IDS.hosted),
    row('row=running elsewhere', IDS.other),
    row('row=stalled', IDS.stalled),
    row('row=paused at a gate here', IDS.gate),
    row('row=paused for a media job, can continue', IDS.media),
    row('row=paused for a media job, nothing to decide', IDS.mediaDone),
    row('row=paused, gate state unknown', IDS.unknown),
    row('row=paused in another project', IDS.elsewhere),
    row('row=paused, project not recorded', IDS.nowhere),
    row('row=end held in the outbox', IDS.held),
    { name: 'tab=active state=run left the list', state: left, foot: { text: true } },
    {
      name: 'tab=active state=Enter with nothing selected',
      state: pressed(left, '', ENTER),
      foot: { text: true },
    },
    {
      name: 'tab=active state=Enter on a read-only row',
      state: pressed(activeHost(everything, IDS.other), '', ENTER),
      foot: { text: true },
    },
    {
      name: 'tab=active state=the last list read',
      state: withActiveFailure(focused),
      foot: { text: true },
    },
    {
      name: 'tab=active state=outbox unreadable',
      state: activeHost(activeRead(EVERY_CLASS, { heldUnread: true }), IDS.gate),
      foot: { text: true },
    },
    {
      name: 'tab=active state=a note',
      state: withActiveNote(focused, 'That run is not paused any more.'),
      foot: { text: true },
    },
    {
      name: 'tab=active state=more rows than listed',
      state: activeHost(
        activeRead(EVERY_CLASS, { more: [{ status: 'running', count: 37, atLeast: false }] }),
        IDS.gate,
      ),
      foot: { text: true },
    },
    { name: 'tab=active rows=0', state: activeHost(activeRead([])), foot: { text: true } },
    { name: 'tab=active phase=loading', state: activeHost(undefined), foot: { text: true } },
    {
      name: 'tab=active phase=unreadable',
      state: enterTab(freshTabMemory('active'), 'active', { port: undefined, now: OPENED }),
    },
  ];
}

// ---- The History tab --------------------------------------------------------------------------------------------------------

const FINISHED: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

function summary(index: number, status: RunStatus): RunSummaryRecord {
  const at = new Date(T0 - index * 1000).toISOString();
  return {
    id: `${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`,
    workflowId: 'wf',
    status,
    executionMode: 'local',
    triggerType: 'manual',
    startedAt: at,
    completedAt: at,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
  };
}

const rowsOf = (records: readonly RunSummaryRecord[]): HistoryEntry[] =>
  buildHistoryRows({
    runs: records,
    nowMs: NOW,
    pinnedRunIds: new Set<string>(),
    workflowLabels: new Map([['wf', 'deploy']]),
  }).map((row): HistoryEntry => ({ kind: 'run', row }));

interface HistoryScript {
  /** The finished runs there are (twenty to a page). */
  readonly total?: number;
  readonly pinned?: readonly HistoryEntry[];
  /** The ids whose cost read throws (a fault that is not about the run). */
  readonly costThrows?: ReadonlySet<string>;
  /** A page that holds no run, whatever the query (`hasNext` / `hasPrev` say whether another page lies past it). */
  readonly emptyPage?: { readonly hasNext: boolean; readonly hasPrev: boolean };
  readonly loadNode?: NodeLoader;
}

function historyPort(script: HistoryScript = {}): HistoryPort {
  const records = Array.from({ length: script.total ?? 5 }, (_, index) =>
    summary(index, FINISHED[index % FINISHED.length] ?? 'completed'),
  );
  return {
    read: (query: HistoryQuery): HistoryRead => {
      if (script.emptyPage !== undefined)
        return {
          query: { scope: query.scope, status: query.status, page: 0 },
          pinned: script.pinned ?? [],
          rows: [],
          hasPrev: script.emptyPage.hasPrev,
          hasNext: script.emptyPage.hasNext,
        };
      const listed = records.filter((r) => query.status === undefined || r.status === query.status);
      const last = Math.max(0, Math.ceil(listed.length / 20) - 1);
      const page = Math.max(0, Math.min(query.page, last));
      return {
        query: { scope: query.scope, status: query.status, page },
        pinned: script.pinned ?? [],
        rows: rowsOf(listed.slice(page * 20, page * 20 + 20)),
        hasPrev: page > 0,
        hasNext: page < last,
      };
    },
    cost: (row) => {
      if (script.costThrows?.has(row.id) === true) throw new Error('a fault of the moment');
      return FINISHED.includes(row.status)
        ? { kind: 'text', text: '$0.0123' }
        : { kind: 'not-final' };
    },
    loadDetail: () => Promise.resolve<RunDetailLoad>({ kind: 'missing' }),
    ...(script.loadNode === undefined ? {} : { loadNode: script.loadNode }),
  };
}

const RUN_ID = '00000000-0000-0000-0000-000000000000';

/** One finished run with one node, `build`, that completed; or one whose end is held in the outbox. */
function detailRead(held = false): RunDetailRead {
  const at = new Date(T0).toISOString();
  const status: RunStatus = held ? 'running' : 'completed';
  const record: RunDetailRecord = {
    ...summary(0, status),
    outputJson: null,
    outputByteLength: null,
    errorJson: null,
    errorByteLength: null,
  };
  const steps: StepSummaryRecord[] = [
    {
      nodeId: 'build',
      nodeType: 'agent',
      status: 'completed',
      attemptNumber: 1,
      startedAt: at,
      completedAt: at,
      durationMs: 3100,
      costMicrocents: 0,
      inputTokens: 12,
      outputTokens: 4,
    },
  ];
  return {
    runId: record.id,
    status,
    model: buildRunDetailModel({
      run: record,
      steps,
      events: [],
      workflowSlug: 'deploy',
      terminalHeld: held,
    }),
    terminalHeld: held,
    heldUnread: false,
    events: Array.from({ length: 3 }, (_, seq) => ({
      seq,
      type: 'node:started' as const,
      nodeId: 'build',
    })),
    eventsComplete: true,
    stepsComplete: true,
    skippedRows: 0,
  };
}

/** The node page's ready read: one node of one attempt that completed. */
function nodeRead(): NodeDetailRead {
  const at = new Date(T0).toISOString();
  const step = {
    nodeId: 'build',
    nodeType: 'agent',
    status: 'completed' as const,
    attemptNumber: 1,
    startedAt: at,
    completedAt: at,
    durationMs: 3100,
    costMicrocents: 0,
    inputTokens: 12,
    outputTokens: 4,
  };
  return {
    runId: RUN_ID,
    nodeId: 'build',
    model: buildNodeDetailModel({
      detail: {
        ...step,
        cachedTokens: 0,
        outputJson: null,
        outputByteLength: null,
        errorJson: null,
        errorByteLength: null,
      },
      attempts: [step],
      events: [],
    }),
    position: { index: 2, of: 4 },
    authoredType: 'agent',
    attemptNumbers: [1],
    eventsComplete: true,
  };
}

const NODE_LOADS = {
  ready: { kind: 'ready', detail: nodeRead() },
  'no attempt': { kind: 'no-attempts', position: { index: 3, of: 4 }, authoredType: 'agent' },
  unavailable: { kind: 'unavailable' },
} as const satisfies Readonly<Record<string, NodeDetailLoad>>;

const historyHost = (port: HistoryPort | undefined): TabHostState =>
  enterTab(freshTabMemory('history'), 'history', { port: undefined, history: port, now: OPENED });

/** The History tab on one run's detail, the host's load landed (`load`), over a port whose node loader answers `node`. */
function historyDetail(load: RunDetailLoad, node?: NodeDetailLoad): TabHostState {
  const port = historyPort(node === undefined ? {} : { loadNode: () => node });
  const loading = enterHistoryAtDetail(
    freshTabMemory('history'),
    { port: undefined, history: port, now: OPENED },
    RUN_ID,
  );
  return withHistoryLoad(loading, RUN_ID, load);
}

/** The node row of the run detail: the header, the run's lines and the table's heading come first. */
const ON_THE_NODE_ROW = 4;

function historyCases(): readonly Case[] {
  const rows = historyHost(historyPort());
  const wide = pressed(rows, 'a', {}, { history: historyPort() });
  const ready = historyDetail({ kind: 'ready', detail: detailRead() });
  const onNode = repeat(ready, ON_THE_NODE_ROW, DOWN, { history: historyPort() });
  const missingPin: HistoryEntry = { kind: 'missing', label: 'deadbeef', pinRowid: 3 };
  const withMissing = historyHost(historyPort({ pinned: [missingPin] }));
  const port = historyPort();
  const nodePage = (name: keyof typeof NODE_LOADS): TabHostState => {
    const detail = historyDetail({ kind: 'ready', detail: detailRead() }, NODE_LOADS[name]);
    const nodePort = historyPort({ loadNode: () => NODE_LOADS[name] });
    return pressed(repeat(detail, ON_THE_NODE_ROW, DOWN, { history: nodePort }), '', ENTER, {
      history: nodePort,
    });
  };
  return [
    // The list.
    { name: 'tab=history list rows=5 scope=project', state: rows },
    { name: 'tab=history list rows=5 scope=all', state: wide },
    {
      name: 'tab=history list rows=5 filter=next status',
      state: pressed(rows, 'f', {}, { history: port }),
    },
    {
      name: 'tab=history list rows=25 more pages',
      state: historyHost(historyPort({ total: 25 })),
    },
    {
      name: 'tab=history list cost read failed',
      state: historyHost(historyPort({ costThrows: new Set([summary(0, 'completed').id]) })),
      foot: { text: true },
    },
    {
      name: 'tab=history list pinned run missing',
      state: withMissing,
      foot: { text: true },
    },
    {
      name: 'tab=history list pinned run missing key=Enter',
      state: pressed(withMissing, '', ENTER, { history: port }),
      foot: { text: true },
    },
    {
      name: 'tab=history list rows=0 status=every finished run',
      state: historyHost(historyPort({ total: 0 })),
      foot: { text: true },
    },
    {
      name: 'tab=history list rows=0 status=completed',
      state: pressed(
        historyHost(historyPort({ total: 0 })),
        'f',
        {},
        { history: historyPort({ total: 0 }) },
      ),
      foot: { text: true },
    },
    {
      name: 'tab=history list rows=0 scope=all',
      state: pressed(
        historyHost(historyPort({ total: 0 })),
        'a',
        {},
        { history: historyPort({ total: 0 }) },
      ),
      foot: { text: true },
    },
    {
      name: 'tab=history list page=empty hasNext',
      state: historyHost(historyPort({ emptyPage: { hasNext: true, hasPrev: false } })),
      foot: { text: true },
    },
    {
      name: 'tab=history list page=empty hasPrev',
      state: historyHost(historyPort({ emptyPage: { hasNext: false, hasPrev: true } })),
      foot: { text: true },
    },
    {
      name: 'tab=history unreadable=no port',
      state: historyHost(undefined),
    },
    // The run's detail.
    { name: 'tab=history detail=loading', state: withLoading() },
    { name: 'tab=history detail=missing', state: historyDetail({ kind: 'missing' }) },
    {
      name: 'tab=history list after the detail could not be loaded',
      state: withHistoryLoadFailure(withLoading(), RUN_ID),
    },
    { name: 'tab=history detail=unreadable', state: historyDetail({ kind: 'unreadable' }) },
    { name: 'tab=history detail=ready', state: ready },
    {
      name: 'tab=history detail=ready end held',
      state: historyDetail({ kind: 'ready', detail: detailRead(true) }),
    },
    {
      name: 'tab=node key=Enter on a line of the run detail that is no node',
      state: pressed(ready, '', ENTER, { history: port }),
    },
    { name: 'tab=history detail=ready cursor=node row', state: onNode },
    // The node page over the detail.
    { name: 'tab=node load=ready', state: nodePage('ready') },
    { name: 'tab=node load=no attempt', state: nodePage('no attempt') },
    { name: 'tab=node load=unavailable', state: nodePage('unavailable') },
  ];
}

/** The History tab while the host's load is still out: the detail is on `Reading the run…`. */
function withLoading(): TabHostState {
  return enterHistoryAtDetail(
    freshTabMemory('history'),
    { port: undefined, history: historyPort(), now: OPENED },
    RUN_ID,
  );
}

// ---- The agents strip -------------------------------------------------------------------------------------------------------

const ready = (slug: string): AgentsModelItem => ({
  entry: { slug, name: `Agent ${slug}`, path: `.relavium/agents/${slug}.agent.yaml`, valid: true },
  agent: {
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system_prompt: 'You review code.',
    tools: ['read_file', 'grep'],
  },
});

const invalidAgent = (slug: string, error: string): AgentsModelItem => ({
  entry: {
    slug,
    name: undefined,
    path: `.relavium/agents/${slug}.agent.yaml`,
    valid: false,
    error,
  },
  agent: undefined,
});

function agentsPort(items: readonly AgentsModelItem[]): AgentsPort {
  return {
    read: () => ({
      model: buildAgentsModel(items),
      slugOf: (index) => items[index]?.entry.slug,
      pathOf: (index) => items[index]?.entry.path,
      definitionOf: (index) => {
        const item = items[index];
        return item?.agent === undefined ? undefined : { id: item.entry.slug, ...item.agent };
      },
    }),
  };
}

const SESSION_ROWS: readonly SessionRow[] = [
  { id: 'sess-aaa', title: 'Fix the flaky test', agent: 'coder', age: '5m ago' },
  { id: 'sess-bbb', title: 'Untitled', agent: 'writer', age: '2h ago' },
];

const sessionsPort = (rows: readonly SessionRow[], more = false): SessionsPort => ({
  read: () => ({ rows, more }),
});

function agentsHost(tab: 'agents' | 'sessions', over: Partial<TabHostContext> = {}): TabHostState {
  return enterTab(freshTabMemory(tab), tab, { port: undefined, now: OPENED, ...over });
}

function agentsCases(): readonly Case[] {
  const items = [
    ready('reviewer'),
    invalidAgent('broken-one', 'unknown key "bogus" at the top level'),
  ];
  const list = agentsHost('agents', { agents: agentsPort(items) });
  const open = pressed(list, '', ENTER, { agents: agentsPort(items) });
  return [
    { name: 'tab=agents rows=2 row=ready', state: list },
    { name: 'tab=agents rows=2 row=invalid', state: pressed(list, '', DOWN), foot: { text: true } },
    {
      name: 'tab=agents rows=2 row=invalid key=Enter',
      state: pressed(pressed(list, '', DOWN), '', ENTER),
      foot: { text: true },
    },
    { name: 'tab=agents detail', state: open },
    {
      name: 'tab=agents rows=0',
      state: agentsHost('agents', { agents: agentsPort([]) }),
      foot: { text: true },
    },
    { name: 'tab=agents unreadable=no port', state: agentsHost('agents') },
  ];
}

function sessionsCases(): readonly Case[] {
  return [
    {
      name: 'tab=sessions rows=2',
      state: agentsHost('sessions', { sessions: sessionsPort(SESSION_ROWS) }),
    },
    {
      name: 'tab=sessions rows=2 older ones exist',
      state: agentsHost('sessions', { sessions: sessionsPort(SESSION_ROWS, true) }),
      foot: { kinds: ['marker', 'legend'], last: 4 },
    },
    {
      name: 'tab=sessions rows=0',
      state: agentsHost('sessions', { sessions: sessionsPort([]) }),
      foot: { kinds: ['text', 'legend'] },
    },
    { name: 'tab=sessions unreadable=no port', state: agentsHost('sessions') },
  ];
}

// ---- Recorders --------------------------------------------------------------------------------------------------------------

/** One item as the legend writes it (`keys verb`): a key table's entry recorded by itself. */
const itemText = (item: LegendItem): string =>
  'keys' in item ? `${keyLabel(item.keys)} ${item.verb}` : item.text;

/** The tab strip's own items and the legends it builds for the Permissions tab, with the roles their keys take. */
const legendRecorder: Recorder = () => {
  const out: Record<string, string | readonly string[]> = {
    'items=TAB_HOST_LEGEND_PLAIN_ITEMS': legend(TAB_HOST_LEGEND_PLAIN_ITEMS, TAB_HOST_KEYS.close),
    'items=TAB_HOST_LEGEND_ROWS_ITEMS': legend(TAB_HOST_LEGEND_ROWS_ITEMS, TAB_HOST_KEYS.close),
    'items=TAB_HOST_KEYS': Object.values(TAB_HOST_KEYS).map(itemText),
    'constant=TAB_HOST_TOO_SMALL': TAB_HOST_TOO_SMALL,
  };
  const cases = permissionsCases();
  Object.assign(out, footStates(cases));
  for (const { name, state } of cases) {
    const line = legendLineOf(state);
    out[`${name} roles`] = rolesOf(line);
  }
  return out;
};

/** The legend's items and its width at the floor, state by state: where `Ctrl+C close` is named and where it is left out for room. */
const interruptRecorder: Recorder = () => {
  const out: Record<string, string> = {};
  const everything: readonly Case[] = [
    ...permissionsCases(),
    ...definedCases(),
    ...activeCases().filter(
      (c) =>
        c.name.includes('row=hosted') || c.name.includes('rows=0') || c.name.includes('phase='),
    ),
    ...historyCases(),
    ...agentsCases(),
    ...sessionsCases(),
  ];
  const floor = usableColumns(GEOMETRIES[0].geometry.columns);
  for (const { name, state } of everything) {
    const { items, exit } = tabHostLegend(state);
    const named = items.some(
      (item) => 'keys' in item && item.keys === TAB_HOST_KEYS.interrupt.keys,
    );
    const text = legend(items, exit);
    out[name] =
      `${named ? 'Ctrl+C named' : 'Ctrl+C left out'} (${String(displayWidth(text))} of ${String(floor)} columns): ${text}`;
  }
  return out;
};

/** What the screen says below the floor, and the `Esc` item it names, by where the person is. */
const tooSmallRecorder: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const nodePort = historyPort({ loadNode: () => NODE_LOADS.ready });
  const nodeState = pressed(
    repeat(
      historyDetail({ kind: 'ready', detail: detailRead() }, NODE_LOADS.ready),
      ON_THE_NODE_ROW,
      DOWN,
      { history: nodePort },
    ),
    '',
    ENTER,
    { history: nodePort },
  );
  const agentPort = agentsPort([ready('reviewer')]);
  const cases: readonly Case[] = [
    { name: 'at=permissions list', state: permissionsHost(permissionsPort(3)) },
    { name: 'at=defined list', state: definedHost(definedPort(READY_ENTRIES)) },
    { name: 'at=active list', state: activeHost(activeRead(EVERY_CLASS)) },
    { name: 'at=history list', state: historyHost(historyPort()) },
    { name: 'at=agents list', state: agentsHost('agents', { agents: agentPort }) },
    {
      name: 'at=sessions list',
      state: agentsHost('sessions', { sessions: sessionsPort(SESSION_ROWS) }),
    },
    {
      name: 'at=agent detail',
      state: pressed(agentsHost('agents', { agents: agentPort }), '', ENTER, { agents: agentPort }),
    },
    { name: 'at=run detail', state: historyDetail({ kind: 'ready', detail: detailRead() }) },
    { name: 'at=node page', state: nodeState },
  ];
  // Below the floor on one side (79 columns) and below it on both (60×20): the frame only asks whether the terminal is 80×24 or more.
  const sizes = [
    { name: 'size=60x20', geometry: BELOW_FLOOR },
    { name: 'size=79x24', geometry: { columns: 79, terminalRows: 24 } },
  ] as const satisfies readonly NamedSize[];
  for (const { name, state } of cases)
    Object.assign(
      out,
      bySize(name, (geometry) => tabHostLines(state, geometry).map((line) => line.text), sizes),
      bySize(
        `${name} roles`,
        (geometry) => [rolesOf(lineOfKind(tabHostLines(state, geometry), 'legend'))],
        sizes,
      ),
    );
  return out;
};

/**
 * The rows of a view that are hint-shaped, drawn without colour and with it. The plain frame decides which rows they are, and the
 * coloured frame gives the same rows with every styled run tagged `⟦style: text⟧`: a row whose key sits in a run of its own (the
 * chip `[d]`, the `d` of `Press d to withdraw it`) is hint-shaped only once its styling is gone.
 */
function coloured(
  name: string,
  element: (color: boolean) => ReactElement,
  columns: number,
): StateRows {
  const plain = plainRows(element(false), { columns });
  const styled = styledRows(element(true), { columns });
  const picked = plain.flatMap((row, index) => (isHintShaped(row) ? [index] : []));
  return {
    [`${name} colour=off`]: picked.map((index) => plain[index] ?? ''),
    [`${name} colour=on`]: picked.map((index) => styled[index] ?? ''),
  };
}

/** The tab host drawn by its view, with colour off and on, for the states whose keys take a role (the withdraw key, the armed question). */
const viewRecorder: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const port = permissionsPort(3);
  const idle = permissionsHost(port);
  const states: readonly (readonly [string, TabHostState])[] = [
    ['tab=permissions state=idle', idle],
    ['tab=permissions state=armed', pressed(idle, 'd', {}, { port, now: SETTLED })],
    ['tab=history list', historyHost(historyPort())],
    ['tab=history detail=ready', historyDetail({ kind: 'ready', detail: detailRead() })],
    ['tab=active row=paused at a gate here', activeHost(activeRead(EVERY_CLASS), IDS.gate)],
  ];
  for (const [name, state] of states)
    Object.assign(
      out,
      coloured(
        name,
        (color) => <TabHostView state={state} color={color} columns={80} rows={24} />,
        80,
      ),
    );
  return out;
};

/** The `/permissions` sheet drawn by its view, with colour off and on: the chip and the hint key take their role on the rows. */
const permissionsSheetViewRecorder: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const snapshot: PermissionsSnapshot = {
    project: grants(2),
    session: [{ argv: ['git', 'status'], text: 'git status', alsoRemembered: true }],
  };
  const idle = initialPermissionsSheetState(snapshot, 'chat', 'ask', OPENED);
  const states: readonly (readonly [string, PermissionsSheetState])[] = [
    ['state=idle row=project', idle],
    ['state=idle row=session', { ...idle, cursor: 2 }],
    ['state=armed row=project', { ...idle, armed: true, armedAt: SETTLED }],
    [
      'state=empty',
      initialPermissionsSheetState({ project: grants(0), session: [] }, 'chat', 'ask', OPENED),
    ],
  ];
  for (const [name, state] of states)
    Object.assign(
      out,
      coloured(
        name,
        (color) => <PermissionsSheetView state={state} color={color} columns={80} rows={24} />,
        80,
      ),
    );
  return out;
};

const definedRecorder: Recorder = () => {
  const out: Record<string, string | readonly string[]> = {
    'constant=DEFINED_NO_DETAIL': DEFINED_NO_DETAIL,
    'items=DEFINED_KEYS': Object.values(DEFINED_KEYS).map(itemText),
  };
  return Object.assign(out, footStates(definedCases()));
};

const activeRecorder: Recorder = () => {
  const out: Record<string, string | readonly string[]> = {
    'constant=ACTIVE_FOCUS_LEFT': ACTIVE_FOCUS_LEFT,
    'constant=ACTIVE_SELECT_FIRST': ACTIVE_SELECT_FIRST,
    'items=ACTIVE_KEYS': Object.values(ACTIVE_KEYS).map(itemText),
  };
  return Object.assign(out, footStates(activeCases()));
};

const historyRecorder: Recorder = () => {
  const out: Record<string, string | readonly string[]> = {
    'constant=HISTORY_HINT': HISTORY_HINT,
    'constant=HISTORY_HINT_MORE': HISTORY_HINT_MORE,
    'constant=HISTORY_EMPTY_PAGE': HISTORY_EMPTY_PAGE,
    'constant=HISTORY_DETAIL_MISSING': HISTORY_DETAIL_MISSING,
    'constant=HISTORY_DETAIL_FAULT': HISTORY_DETAIL_FAULT,
    'constant=HISTORY_DETAIL_UNREADABLE': HISTORY_DETAIL_UNREADABLE,
    'constant=HISTORY_UNREADABLE': HISTORY_UNREADABLE,
    'constant=HISTORY_COST_FAULT': HISTORY_COST_FAULT,
    'constant=HISTORY_MISSING_RUN': HISTORY_MISSING_RUN,
    'items=HISTORY_KEYS': Object.values(HISTORY_KEYS).map(itemText),
  };
  // The node page and the `Enter` that opens it are the node recorder's.
  Object.assign(
    out,
    footStates(historyCases().filter((candidate) => !candidate.name.startsWith('tab=node '))),
  );
  return out;
};

const nodeRecorder: Recorder = () => {
  const out: Record<string, string | readonly string[]> = {
    'constant=NODE_NOT_A_NODE': NODE_NOT_A_NODE,
    'items=NODE_KEYS': Object.values(NODE_KEYS).map(itemText),
  };
  // The node page's legend and the footer under it, by what the loader answered; and `Enter` on a line of the run detail that is no node.
  return Object.assign(
    out,
    footStates(historyCases().filter((c) => c.name.startsWith('tab=node '))),
  );
};

const agentsRecorder: Recorder = () => ({
  'items=AGENTS_KEYS': Object.values(AGENTS_KEYS).map(itemText),
  ...footStates(agentsCases()),
});

const sessionsRecorder: Recorder = () => ({
  'constant=SESSIONS_RESUME_UNAVAILABLE': SESSIONS_RESUME_UNAVAILABLE,
  'items=SESSIONS_KEYS': Object.values(SESSIONS_KEYS).map(itemText),
  ...footStates(sessionsCases()),
});

/** Where `[p] pin` joins a legend: asked of the items each state builds, never written by hand. */
const pinRecorder: Recorder = () => {
  const out: Record<string, string> = { 'item=PIN_KEY': itemText(PIN_KEY) };
  const cases: readonly Case[] = [
    ...definedCases().filter(
      (c) => c.name === 'tab=defined rows=3 row=ready' || c.name === 'tab=defined rows=0',
    ),
    ...historyCases().filter(
      (c) =>
        c.name.includes('list rows=5 scope=project') ||
        c.name.includes('list rows=0 status=every') ||
        c.name === 'tab=history detail=ready' ||
        c.name === 'tab=history detail=missing' ||
        c.name === 'tab=node load=ready',
    ),
    ...permissionsCases().slice(0, 1),
    ...agentsCases().slice(0, 1),
    ...sessionsCases().slice(0, 1),
    ...activeCases().slice(0, 1),
  ];
  for (const { name, state } of cases) {
    const joins = tabHostLegend(state).items.some(
      (item) => 'keys' in item && item.keys === PIN_KEY.keys && item.verb === PIN_KEY.verb,
    );
    out[`${name} legend names [p] pin`] = joins ? 'yes' : 'no';
  }
  return out;
};

export const TAB_HOST_PRODUCERS: readonly Producer[] = [
  {
    id: 'tab-host-legend',
    file: 'render/tui/tab-host.ts',
    describe:
      'The strip’s own legend items (`←/→ tab · Tab cycle · … · Esc close`) and the Permissions tab’s legend and message row by state (rows, none, withdrawal armed, a refused key, unreadable), at 80 and 100 columns, with the roles of the keys.',
  },
  {
    id: 'tab-host-interrupt',
    file: 'render/tui/tab-host.ts',
    describe:
      'Whether `Ctrl+C close` joins a tab’s legend: named only where the whole legend fits the 80-column floor; recorded per tab and state with the legend’s width.',
  },
  {
    id: 'tab-host-too-small',
    file: 'render/tui/tab-host.ts',
    describe:
      'TAB_HOST_TOO_SMALL and the `Esc` item below 80×24, per level: a tab’s list (`Esc close`), an agent’s detail, a run’s detail (`Esc back to the list`) and a node page (`Esc back to the run`).',
  },
  {
    id: 'tab-host-view',
    file: 'render/tui/tab-host-view.tsx',
    describe:
      'The tab host drawn by its view with colour off and on: the legend and hint rows with the style each key takes (Permissions idle and armed, History list and detail, Active).',
  },
  {
    id: 'permissions-sheet-view',
    file: 'render/tui/permissions-sheet-view.tsx',
    describe:
      'The /permissions sheet drawn by its view with colour off and on: the chip `[d] withdraw` / `[Enter] withdraw`, the hint under the selected row and the legend, with the style each key takes (idle, armed, empty).',
  },
  {
    id: 'tab-host-workflows',
    file: 'render/tui/tab-host-workflows.ts',
    describe:
      'The Defined tab: its legend by state (rows, none, unreadable), the sentences that name a key (`Enter` says no detail yet, a pin of another project, an empty list), at 80 and 100 columns.',
  },
  {
    id: 'tab-host-active',
    file: 'render/tui/tab-host-active.ts',
    describe:
      'The Active tab: its legend by state, the sentence under the list for every class of run (those naming `Enter`), the focus-left and select-first messages, the freshness footers and the empty list.',
  },
  {
    id: 'tab-host-history',
    file: 'render/tui/tab-host-history.ts',
    describe:
      'The History tab: the list legend by scope, filter, paging and emptiness, HISTORY_HINT and its siblings, the cost-fault line, a missing pin; and the run detail legend (loading, missing, unreadable, ready) with its footer.',
  },
  {
    id: 'tab-host-node',
    file: 'render/tui/tab-host-node.ts',
    describe:
      'The node page over a run’s detail: its legend by what the loader answered (ready, no attempt, unavailable), its footer, and the `Enter` sentence on a line that is no node.',
  },
  {
    id: 'tab-host-agents',
    file: 'render/tui/tab-host-agents.ts',
    describe:
      'The /agents strip’s Defined tab: its legend on the list (ready row, invalid row, none, unreadable) and on an agent’s detail (`[c] chat · Esc back`).',
  },
  {
    id: 'tab-host-sessions',
    file: 'render/tui/tab-host-sessions.ts',
    describe:
      'The /agents strip’s Sessions tab: its legend (rows, none, unreadable) and the line that says older conversations are not listed.',
  },
  {
    id: 'tab-host-pin',
    file: 'render/tui/tab-host-pin.ts',
    describe:
      'The `[p] pin` item and every legend it joins (Defined rows, History list rows, History detail, the node page), asked of the items each state builds.',
  },
];

export const TAB_HOST_RECORDERS = {
  'tab-host-legend': legendRecorder,
  'tab-host-interrupt': interruptRecorder,
  'tab-host-too-small': tooSmallRecorder,
  'tab-host-view': viewRecorder,
  'permissions-sheet-view': permissionsSheetViewRecorder,
  'tab-host-workflows': definedRecorder,
  'tab-host-active': activeRecorder,
  'tab-host-history': historyRecorder,
  'tab-host-node': nodeRecorder,
  'tab-host-agents': agentsRecorder,
  'tab-host-sessions': sessionsRecorder,
  'tab-host-pin': pinRecorder,
} as const satisfies Readonly<Record<string, Recorder>>;
