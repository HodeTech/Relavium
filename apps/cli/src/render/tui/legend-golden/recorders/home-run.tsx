import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder, type Rows } from '../golden.js';
import { isHintShaped } from '../hint-shape.js';
import type { RunDeparture } from '@relavium/core';
import { describeHostedRunTerminal } from '../../../../home/hosted-run-terminal.js';
import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../../../home/home-store.js';
import { budgetCardGates, type RunGate, type RunGates } from '../../../../home/run-gates.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../../../home/run-host.js';
import {
  HOSTED_RUN_ENTER_CUE,
  exitGuardLines,
  hostedRunLabel,
  type ExitGuardPhase,
} from '../../home-projection.js';
import { parkedRunLabel, type ParkedRunKind, type ParkedRunRow } from '../../home-attention.js';
import { HomeView } from '../../home-view.js';
import { projectRunCard, type RunCardPhase, type RunCardSnapshot } from '../../run-card-model.js';
import { runScreenModel, type RunScreenInput } from '../../run-screen.js';
import type { StripFocus } from '../../strip-focus.js';

/**
 * The Home's own hints and the cards a hosted run raises ([ADR-0139](../../../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md),
 * ADR-0140): the hint bar under the prompt in every state it has, the exit-guard card, the run view's key line, the gate and budget
 * card's key line and the cue each parked row carries. The hint bar is not exported, so the Home view is mounted and the hint-shaped
 * rows of its frame are the recording.
 */

export const HOME_RUN_PRODUCERS: readonly Producer[] = [
  {
    id: 'home-view-hint',
    file: 'render/tui/home-view.tsx',
    describe:
      'the hint bar under the Home’s prompt (and its focused-row cues) by page x focus x draft x key x run x sessions x parked runs x armed, and the below-80x24 exit line',
  },
  {
    id: 'home-attention-cue',
    file: 'render/tui/home-attention.ts',
    describe:
      'the key a parked run’s row names (`Enter opens`, `↓ selects`, …) by the kind of gate it waits on',
  },
  {
    id: 'home-exit-guard',
    file: 'render/tui/home-projection.ts',
    describe:
      'the exit-guard card’s lines (what leaving does and which keys stay) by phase and by the state of the run, and the ▶ row’s Enter cue',
  },
  {
    id: 'run-screen-keys',
    file: 'render/tui/run-screen.ts',
    describe: 'the run view’s key line by phase x armed x gate offered x gate open failed x size',
  },
  {
    id: 'run-card-keys',
    file: 'render/tui/run-card-model.ts',
    describe:
      'the gate and budget card’s key line (and any row naming a key) by phase x what the gate accepts x several gates x size',
  },
];

// ── the Home view ────────────────────────────────────────────────────────────────────────────────────────────────────────

const runRow = (id: string, status: HomeRunRow['status']): HomeRunRow => ({
  runId: `run-${id}`,
  workflowSlug: `wf-${id}`,
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const sessionRow = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: `/work/${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});

/** A snapshot of this directory; `parked` is how many parked runs the store counts (their rows are the controller's own read). */
const snapshotOf = (over: {
  sessions?: boolean | undefined;
  runs?: boolean | undefined;
  parked?: number | undefined;
}): HomeSnapshot => ({
  attention: { failedRuns: [] },
  recentSessions: over.sessions === true ? [sessionRow(1)] : [],
  recentRuns: over.runs === true ? [runRow('1', 'completed')] : [],
  recentAgents: [],
  unreadableRuns: [],
  totals: {
    attention: over.parked ?? 0,
    sessions: over.sessions === true ? 1 : 0,
    runs: over.runs === true ? 1 : 0,
  },
  isEmpty: over.sessions !== true && over.runs !== true,
});

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const EXECUTING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};
const CANCELLING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: true },
  last: undefined,
};
const PREPARING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: undefined, cancelling: false },
  last: undefined,
};

const parked = (kind: ParkedRunKind, gates = 1): ParkedRunRow => ({ runId: 'run-p1', kind, gates });

interface HomeCase {
  readonly state: string;
  readonly sessions?: boolean;
  readonly runs?: boolean;
  readonly text?: string;
  readonly keyless?: boolean;
  readonly armed?: boolean;
  readonly hostedRun?: RunHostSnapshot;
  readonly parked?: readonly ParkedRunRow[];
  readonly focus?: StripFocus;
  readonly exitGuard?: ExitGuardPhase;
  readonly size?: { cols: number; rows: number };
  /** The page drawn (MVP-11 unit 7): the work page for a focused row, else the landing, unless the case names one. */
  readonly page?: 'start' | 'work';
}

const PARKED_KINDS: readonly ParkedRunKind[] = [
  'approval',
  'input',
  'review',
  'budget',
  'several',
  'media',
  'none',
];

const HOME_CASES: readonly HomeCase[] = [
  { state: 'idle, nothing to continue' },
  // The empty Home is left-hung (ADR-0146 §1): its hint has the terminal's width less the margin, so at 80 columns the standing sentence drops.
  { state: 'idle, nothing to continue, 80x24', size: { cols: 80, rows: 24 } },
  { state: 'idle, saved sessions', sessions: true },
  { state: 'idle, a parked run', parked: [parked('approval')] },
  { state: 'idle, a draft', text: 'hello' },
  { state: 'idle, a slash draft', text: '/mod' },
  { state: 'idle, keyless', keyless: true },
  { state: 'idle, keyless, 80x24', keyless: true, size: { cols: 80, rows: 24 } },
  { state: 'idle, keyless, a draft', keyless: true, text: 'hello' },
  { state: 'idle, keyless, a slash draft', keyless: true, text: '/mod' },
  { state: 'the first Ctrl+C is armed', armed: true },
  { state: 'a run executing, nothing else', hostedRun: EXECUTING },
  { state: 'a run executing, saved sessions', hostedRun: EXECUTING, sessions: true },
  { state: 'a run executing, a parked run', hostedRun: EXECUTING, parked: [parked('approval')] },
  { state: 'a run executing, keyless', hostedRun: EXECUTING, keyless: true },
  { state: 'a run preparing (no run id yet)', hostedRun: PREPARING },
  {
    state: 'a session row is focused',
    sessions: true,
    focus: { kind: 'session', id: 'session-1' },
  },
  { state: 'a recent run row is focused', runs: true, focus: { kind: 'run', id: 'run-1' } },
  ...PARKED_KINDS.map(
    (kind): HomeCase => ({
      state: `a parked run row is focused, kind=${kind}`,
      parked: [parked(kind, kind === 'several' ? 3 : 1)],
      focus: { kind: 'run', id: 'run-p1' },
    }),
  ),
  // The work page with its docked prompt focused (MVP-11 unit 7): its own hint, its way back last.
  { state: 'the work page, the docked prompt', sessions: true, page: 'work' },
  {
    state: 'the work page, the docked prompt, a draft',
    sessions: true,
    page: 'work',
    text: 'hello',
  },
  {
    state: 'the work page, the docked prompt, a slash draft',
    sessions: true,
    page: 'work',
    text: '/mod',
  },
  {
    state: 'the work page, the docked prompt, keyless',
    sessions: true,
    page: 'work',
    keyless: true,
  },
  {
    state: 'the work page, the docked prompt, keyless, a draft',
    sessions: true,
    page: 'work',
    keyless: true,
    text: 'hello',
  },
  {
    state: 'the work page, the docked prompt, a run executing',
    sessions: true,
    page: 'work',
    hostedRun: EXECUTING,
  },
  { state: 'the work page, armed', sessions: true, page: 'work', armed: true },
  {
    state: 'the work page, exit guard asks',
    sessions: true,
    page: 'work',
    hostedRun: EXECUTING,
    exitGuard: 'confirm',
  },
  { state: 'exit guard asks, a run executing', hostedRun: EXECUTING, exitGuard: 'confirm' },
  { state: 'exit guard waits for the run to stop', hostedRun: CANCELLING, exitGuard: 'stopping' },
  { state: 'below 80x24', size: { cols: 70, rows: 20 } },
  { state: 'below 80x24, armed', size: { cols: 70, rows: 20 }, armed: true },
  {
    state: 'below 80x24, exit guard asks',
    size: { cols: 70, rows: 20 },
    hostedRun: EXECUTING,
    exitGuard: 'confirm',
  },
];

/** Whether the case is drawn at a size the Home's pages are drawn at: both pages are left-hung at the margin (below 80×24, the degrade is not). */
const isLeftHung = (item: HomeCase): boolean =>
  item.size === undefined || (item.size.cols >= 80 && item.size.rows >= 24);

const homeView = (item: HomeCase, color: boolean) => {
  const size = item.size ?? { cols: 100, rows: 30 };
  return (
    <HomeView
      page={item.page ?? (item.focus === undefined ? 'start' : 'work')}
      snapshot={snapshotOf({
        sessions: item.sessions,
        runs: item.runs,
        parked: item.parked?.length,
      })}
      editor={{ text: item.text ?? '', cursor: (item.text ?? '').length }}
      nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
      cols={size.cols}
      rows={size.rows}
      color={color}
      keyless={item.keyless === true}
      interruptArmed={item.armed === true}
      hostedRun={item.hostedRun ?? IDLE}
      parkedRuns={item.parked}
      stripFocus={item.focus}
      exitGuard={item.exitGuard}
    />
  );
};

const homeHint: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const item of HOME_CASES) {
    // The frame is drawn at the 100 columns the test renderer has; the size above is what the view lays itself out for. The pages' rows start
    // at their left margin, which is layout and not wording: a row of a page is recorded from its first word.
    const states = legendStates(item.state, (color) => homeView(item, color), { columns: 100 });
    for (const [name, rows] of Object.entries(states))
      out[name] = isLeftHung(item) ? rows.map((row) => row.trimStart()) : rows;
  }
  return out;
};

const attentionCue: Recorder = () => {
  const out: Record<string, string> = {};
  for (const kind of PARKED_KINDS) {
    const row = parked(kind, kind === 'several' ? 3 : 1);
    out[label({ kind, focused: true })] = parkedRunLabel(row, true, 120, 0);
    out[label({ kind, focused: false })] = parkedRunLabel(row, false, 120, 0);
  }
  out[label({ kind: 'approval', focused: true, columns: 40 })] = parkedRunLabel(
    parked('approval'),
    true,
    40,
    0,
  );
  return out;
};

const exitGuard: Recorder = () => {
  const out: Record<string, Rows> = {};
  const snapshots: readonly (readonly [string, RunHostSnapshot])[] = [
    ['no run', IDLE],
    ['executing', EXECUTING],
    ['stopping', CANCELLING],
    ['preparing', PREPARING],
  ];
  for (const [name, snapshot] of snapshots) {
    for (const phase of ['confirm', 'stopping'] as const) {
      out[label({ run: name, phase })] = exitGuardLines(phase, snapshot, 12);
    }
  }
  out['the ▶ row, executing'] = [hostedRunLabel(EXECUTING) ?? ''];
  out['the ▶ row, preparing'] = [hostedRunLabel(PREPARING) ?? ''];
  out['the ▶ row, cancelling'] = [hostedRunLabel(CANCELLING) ?? ''];
  out['the Enter cue'] = HOSTED_RUN_ENTER_CUE;
  return out;
};

// ── the run view ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const DETACHED: Exclude<RunDeparture, { readonly kind: 'continue' }> = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

function ended(outcome: 'completed' | 'failed' | 'paused' | 'cancelled'): RunHostSnapshot {
  const terminal = describeHostedRunTerminal({
    leg: 'start',
    runId: 'run-0001',
    outcome,
    durability: 'durable',
    terminalError: undefined,
    departure: DETACHED,
  });
  const end: HostedLegEnd = {
    leg: 'start',
    runId: 'run-0001',
    terminal,
    handedOff: terminal.disposition === 'paused',
    retirement: 'retired',
    fault: undefined,
  };
  return { launching: false, active: undefined, last: end };
}

const runScreenKeys: Recorder = () => {
  const out: Record<string, string> = {};
  const phases: readonly (readonly [string, RunHostSnapshot | undefined])[] = [
    ['running', EXECUTING],
    ['cancelling', CANCELLING],
    ['completed', ended('completed')],
    ['paused', ended('paused')],
    ['failed', ended('failed')],
    ['not held', IDLE],
  ];
  for (const [phase, snapshot] of phases) {
    for (const armed of [false, true]) {
      for (const [openGate, gateOpenFailed] of [
        [false, false],
        [true, false],
        [true, true],
      ] as const) {
        const input: RunScreenInput = {
          runId: 'run-0001',
          snapshot,
          notices: [],
          armed,
          columns: 100,
          rows: 30,
          openGate,
          gateOpenFailed,
        };
        out[label({ phase, armed, openGate, gateOpenFailed })] = runScreenModel(input).keys;
      }
    }
    out[label({ phase, size: '70x20' })] = runScreenModel({
      runId: 'run-0001',
      snapshot,
      notices: [],
      armed: false,
      columns: 70,
      rows: 20,
      openGate: true,
    }).keys;
  }
  return out;
};

// ── the gate and budget card ─────────────────────────────────────────────────────────────────────────────────────────────

const humanGate = (id: string, accepts: RunGate['accepts']): RunGate => ({
  runId: 'run-0001',
  gateId: id,
  nodeId: `node-${id}`,
  gateType: 'approval',
  message: `Approve ${id}?`,
  accepts,
});

const budgetGates = (
  allowance: RunGates['budgetGates'][number]['allowance'],
): RunCardSnapshot['gates'] =>
  budgetCardGates({
    runId: 'run-0001',
    workflowId: 'wf',
    gates: [],
    budgetGates: [{ gateId: 'b1', nodeId: 'writer', allowance }],
    degraded: false,
  });

const cardSnapshot = (
  gates: RunCardSnapshot['gates'],
  over: { phase?: RunCardPhase; notice?: string; refused?: boolean } = {},
): RunCardSnapshot => ({
  runId: 'run-0001',
  gates,
  cursor: 0,
  phase: over.phase ?? 'open',
  notice: over.notice,
  refused: over.refused ?? false,
});

const runCardKeys: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const both = humanGate('g1', ['approved', 'rejected']);
  const cases: readonly (readonly [string, RunCardSnapshot])[] = [
    ['a gate that accepts approval and rejection', cardSnapshot([both])],
    ['a gate that accepts rejection only', cardSnapshot([humanGate('g1', ['rejected'])])],
    ['a gate that accepts approval only', cardSnapshot([humanGate('g1', ['approved'])])],
    ['two gates', cardSnapshot([both, humanGate('g2', ['approved', 'rejected'])])],
    [
      'a budget gate, an exact amount',
      cardSnapshot(budgetGates({ kind: 'amount', microcents: 4_200_000 })),
    ],
    [
      'a budget gate that can only be rejected',
      cardSnapshot(budgetGates({ kind: 'reject_only', reason: 'unpriced' })),
    ],
    ['a budget gate with no allowance (legacy)', cardSnapshot(budgetGates({ kind: 'legacy' }))],
    ['an answer is out', cardSnapshot([both], { phase: 'answering' })],
    [
      'the leg that carries the answer started',
      cardSnapshot([both], { phase: 'answered', notice: 'Resumed.' }),
    ],
    [
      'the gate was already decided',
      cardSnapshot([both], { phase: 'settled', notice: 'Already decided.' }),
    ],
    ['no gate is open', cardSnapshot([], { phase: 'empty' })],
    ['the host refused the answer', cardSnapshot([both], { notice: 'Refused.', refused: true })],
  ];
  for (const [state, snapshot] of cases) {
    for (const [name, size] of [
      ['80x24', { columns: 80, rows: 24 }],
      ['100x30', { columns: 100, rows: 30 }],
      ['70x20', { columns: 70, rows: 20 }],
    ] as const) {
      const projection = projectRunCard(snapshot, { ...size, nowMs: 0 });
      out[label({ state, size: name })] = projection.rows
        .map((row) => row.text)
        .filter((text) => isHintShaped(text));
    }
  }
  return out;
};

export const HOME_RUN_RECORDERS = {
  'home-view-hint': homeHint,
  'home-attention-cue': attentionCue,
  'home-exit-guard': exitGuard,
  'run-screen-keys': runScreenKeys,
  'run-card-keys': runCardKeys,
} as const satisfies Readonly<Record<string, Recorder>>;
