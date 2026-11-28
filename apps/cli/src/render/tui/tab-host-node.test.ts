/**
 * The node page of the Home's History tab ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, §4, MVP-8 step 4): what a node's page shows, the order it takes from the run's frozen workflow, the keys `Enter`, `n`, `p` and `Esc`, the
 * words it uses for what is absent (compared with the reference), and that no value reaches a line raw. The keys go through the tab host's own
 * fold over the REAL loaders and the real pin store on an in-memory `history.db` seeded through the real store (`node-run-fixture.ts`), so a
 * test reads back what a person would see; the one test of hostile text builds its model by hand, because a stored toolId is bound by the
 * event schema and a hostile one cannot be written through the store.
 */
import {
  MAX_RUN_PINS,
  createClient,
  createRunHistoryReader,
  createRunPinStore,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
  type RunPinStore,
  type StepDetailRecord,
  type StepSummaryRecord,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHistorySource } from '../../history/history-source.js';
import { buildNodeDetailModel } from '../../history/node-detail-model.js';
import {
  createNodeDetailLoader,
  type NodeDetailLoad,
  type NodeDetailRequest,
} from '../../history/node-detail-source.js';
import {
  FIXTURE_NODES,
  FIXTURE_RUN_IDS,
  FIXTURE_SNAPSHOT,
  seedFixtureRuns,
} from '../../history/node-run-fixture.js';
import { buildRunDetailModel, type NodeRow } from '../../history/run-detail-model.js';
import { createRunDetailLoader } from '../../history/run-detail-source.js';
import { createPinPort } from '../../home/pin-port.js';
import { readAbsenceReference } from '../../test-support.js';
import { ABSENCE_SENTENCES } from '../absence.js';
import type { ChatKey } from './chat-input.js';
import { usableColumns } from './sheet-frame.js';
import {
  TAB_HOST_ROWS,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegend,
  tabHostLegendText,
  tabHostLines,
  withHistoryLoad,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';
import {
  NODE_FAULT,
  NODE_KEYS,
  NODE_LOG_PARTIAL,
  NODE_NOT_A_NODE,
  NODE_NOT_HERE,
  NODE_NO_ATTEMPT,
  NODE_NO_FAILED,
  NODE_RETRIED_OK,
  firstFailedAttempt,
  nodeBody,
  nodeShowingFirstFailed,
  openNodeTab,
  type NodeTabState,
} from './tab-host-node.js';
import { PIN_UNAVAILABLE } from './tab-host-pin.js';
import { displayWidth } from './viewport.js';

const UP: ChatKey = { upArrow: true };
const DOWN: ChatKey = { downArrow: true };
const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };
const BACKSPACE: ChatKey = { backspace: true };
const NOW = 1_750_000_000_000 + 3_600_000;
const ROOT = '/work/project';

let client: DbClient;
let reader: RunHistoryReader;
let store: RunPinStore;

beforeEach(async () => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
  store = createRunPinStore(client.db);
  await seedFixtureRuns(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

interface RigOptions {
  /** The frozen snapshot every read sees; `undefined` for a run whose snapshot is gone. */
  readonly snapshot?: () => string | undefined;
  /** Replaces the node loader (a spy, a failure). */
  readonly loadNode?: ((request: NodeDetailRequest) => NodeDetailLoad) | undefined;
  /** No node loader at all. */
  readonly withoutLoadNode?: boolean;
  /** No pin store behind `p`. */
  readonly withoutPins?: boolean;
  /** The terminal outbox holds these runs' ends. */
  readonly held?: readonly string[];
}

/** The History tab over the real loaders, with keys going through the tab host's own fold. */
function rig(options: RigOptions = {}) {
  const snapshot = options.snapshot ?? ((): string | undefined => FIXTURE_SNAPSHOT);
  const realNode = createNodeDetailLoader({ reader, loadSnapshot: snapshot });
  const loadNode = vi.fn(options.loadNode ?? realNode);
  const history: HistoryPort = {
    ...createHistorySource({
      reader,
      listRunPins: () => store.listPins({ kind: 'run' }),
      projectRoot: ROOT,
      now: () => NOW,
    }),
    loadDetail: createRunDetailLoader({
      reader,
      projectRoot: ROOT,
      listHeld: () => Promise.resolve((options.held ?? []).map((runId) => ({ runId }))),
      loadSnapshot: snapshot,
    }),
    ...(options.withoutLoadNode === true ? {} : { loadNode }),
  };
  const pins =
    options.withoutPins === true
      ? undefined
      : createPinPort({ store, workflowRoot: () => ROOT, now: () => NOW });
  const context = (): TabHostContext => ({
    history,
    pins,
    now: 10_000,
  });
  let state: TabHostState = enterTab(freshTabMemory('history'), 'history', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  const lines = () => tabHostLines(state, { columns: 80, terminalRows: 24 });
  const text = (): string =>
    lines()
      .map((line) => line.text)
      .join('\n');
  const selected = (): string => lines().find((line) => line.kind === 'selected')?.text ?? '';
  /** Open a run's detail directly (the list shows finished runs of the project only; the fixture has none in this project). */
  const openRun = async (runId: string): Promise<void> => {
    const host = state;
    if (host.history === undefined) throw new Error('the History tab was read');
    const loading: TabHostState = {
      ...host,
      history: { ...host.history, detail: { runId, phase: 'loading', cursor: 0, pinned: false } },
    };
    state = withHistoryLoad(loading, runId, await history.loadDetail(runId));
    if (state.history?.detail?.phase !== 'ready') throw new Error('the detail is not ready');
  };
  /** Press `↓` until the selected line is the table row of the node `label` (a status word, then the label). */
  const moveTo = (label: string): void => {
    const row = new RegExp(
      `(completed|failed|pending|skipped|running|stopped)\\s+${label}(\\s|$)`,
      'u',
    );
    for (let index = 0; index < 60; index += 1) {
      if (row.test(selected())) return;
      press('', DOWN);
    }
    throw new Error(`no row for ${label}: ${text()}`);
  };
  /** Open a run the way a person does: widen the list to every project, move to the run's row, `Enter`, and take the load the host reads. */
  const openFromList = async (runId: string): Promise<void> => {
    press('a');
    const rows = state.history?.read?.rows ?? [];
    const at = rows.findIndex((entry) => entry.kind === 'run' && entry.row.id === runId);
    if (at < 0) throw new Error(`the run is not listed: ${runId}`);
    const pinned = state.history?.read?.pinned.length ?? 0;
    // A bounded walk: a list that never moves fails with the run it was looking for instead of looping (review round 1, D08/D09).
    for (let step = 0; (state.history?.cursor ?? 0) < pinned + at; step += 1) {
      if (step >= 200) throw new Error(`the cursor never reached the run ${runId}`);
      press('', DOWN);
    }
    const step = press('', ENTER);
    if (step.kind !== 'open-detail') throw new Error(`Enter did not open the run: ${step.kind}`);
    state = withHistoryLoad(state, runId, await history.loadDetail(runId));
  };
  /** The lines of the node page, as text (label, then the right-hand figures). */
  const page = (): string[] => {
    const node = state.history?.detail?.node;
    if (node === undefined) throw new Error('the node page is not open');
    return node.lines.map((line) =>
      line.right === undefined ? line.left : `${line.left}  ${line.right}`,
    );
  };
  const openNode = async (runId: string, label: string): Promise<void> => {
    await openRun(runId);
    moveTo(label);
    press('', ENTER);
    if (state.history?.detail?.node === undefined)
      throw new Error(
        `the node ${label} did not open: ${state.history?.detail?.message ?? ''}\n${text()}`,
      );
  };
  return {
    press,
    lines,
    text,
    selected,
    openRun,
    openFromList,
    openNode,
    moveTo,
    page,
    loadNode,
    context,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
    detail: () => state.history?.detail,
    node: () => state.history?.detail?.node,
    message: (): string | undefined =>
      state.history?.detail?.node?.message ?? state.history?.detail?.message,
  };
}

const includesLine = (lines: readonly string[], needle: string): boolean =>
  lines.some((line) => line.includes(needle));

/**
 * The figures a page line says, one by one: the line cut at its separators (two spaces, ` · `, `: `), the word a figure follows (`Tokens`,
 * `cost`, `took`) and the glyph a heading starts with taken off. A sentence is then compared with a whole figure, not found inside a longer
 * one (`not recorded` is a part of `not recorded (older log)`, and a substring check would let either stand for the other).
 */
function figuresOf(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    line
      .split(/ {2,}|\s·\s|: /u)
      .map((part) =>
        part
          .trim()
          .replace(/^(Tokens|cost|took) /u, '')
          .replace(/^[^\p{L}\p{N}\s(]\s/u, ''),
      )
      .filter((part) => part !== ''),
  );
}

describe('what the node page shows', () => {
  it('shows the node`s order and type from the frozen workflow, what was authored beside what ran, every attempt, its tools and its output', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    const page = r.page();
    expect(page[0]).toBe('✓ completed  build');
    expect(page[1]).toBe('Order in the workflow: 2 of 4  ·  type agent');
    expect(page).toContain('Authored: agent builder  ·  model claude-builder');
    expect(page).toContain('Ran on: claude-builder');
    expect(page).toContain('Attempts (2)');
    expect(includesLine(page, 'attempt 1  failed')).toBe(true);
    expect(includesLine(page, 'attempt 2  completed')).toBe(true);
    expect(page).toContain('Tool activity (attempt 2)');
    expect(page).toContain('  no tool calls');
    expect(page).toContain('Output (attempt 2)');
    expect(includesLine(page, '"built": true')).toBe(true);
    expect(includesLine(page, '#')).toBe(true);
    // The input of a node is never shown: nothing of it is recorded.
    expect(page.join('\n')).not.toMatch(/input/iu);
  });

  it('draws the page inside the 80×24 budget with the legend last and the way back named', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    for (let step = 0; step < 40; step += 1) {
      const lines = r.lines();
      expect(lines.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
      for (const line of lines)
        expect(displayWidth(line.text), line.text).toBeLessThanOrEqual(usableColumns(80));
      expect(lines.at(-1)?.kind).toBe('legend');
      // `Tab` is no item of the legend (two tabs: `←/→ tab` says it), so `[Ctrl+C] close` fits the 78 columns beside the node page's own keys
      expect(lines.at(-1)?.text).toBe(
        '←/→ tab · ↑/↓ scroll · [n] first failed · [Ctrl+C] close · Esc back',
      );
      expect(lines.filter((line) => line.kind === 'selected')).toHaveLength(1);
      r.press('', DOWN);
    }
  });

  it('scrolls with ↑/↓, PgUp/PgDn, Home and End and stops at the ends, with a marker for what it hides', async () => {
    const r = rig();
    const output = Array.from({ length: 30 }, (_, index) => `row ${String(index + 1)}`).join('\n');
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(JSON.stringify(output), FIXTURE_RUN_IDS.reversed);
    await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
    const last = (r.node()?.lines.length ?? 0) - 1;
    expect(last).toBeGreaterThan(30);
    r.press('', UP);
    expect(r.node()?.cursor).toBe(0);
    expect(r.text()).not.toContain('▲');
    expect(r.text()).toContain('▼');
    r.press('', { pageDown: true });
    expect(r.node()?.cursor).toBe(8);
    r.press('', { pageDown: true });
    r.press('', { pageDown: true });
    expect(r.node()?.cursor).toBe(24);
    expect(r.text()).toContain('▲');
    expect(r.text()).toContain('▼');
    r.press('', { pageUp: true });
    expect(r.node()?.cursor).toBe(16);
    r.press('', { end: true });
    expect(r.node()?.cursor).toBe(last);
    expect(r.text()).toContain('▲');
    expect(r.text()).not.toContain('▼');
    r.press('', DOWN);
    expect(r.node()?.cursor).toBe(last);
    r.press('', { home: true });
    expect(r.node()?.cursor).toBe(0);
  });

  it('is left with Esc or Backspace for the run detail on the node row it came from, and Ctrl+C closes the screen from the page', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'review');
    r.press('', DOWN);
    r.press('', ESC);
    expect(r.node()).toBeUndefined();
    expect(r.detail()?.runId).toBe(FIXTURE_RUN_IDS.failed);
    expect(r.selected()).toContain('review');
    r.press('', ENTER);
    expect(r.node()).toBeDefined();
    r.press('', BACKSPACE);
    expect(r.node()).toBeUndefined();
    r.press('', ENTER);
    expect(r.press('c', { ctrl: true }).kind).toBe('close');
  });

  it('names exactly the keys it answers to, and each does what it says', async () => {
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.failed);
    expect(tabHostLegendText(r.state)).toBe(
      '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · Esc back',
    );
    r.press('n');
    expect(r.selected()).toContain('review');
    r.press('', ENTER);
    expect(tabHostLegendText(r.state)).toBe(
      '←/→ tab · ↑/↓ scroll · [n] first failed · [Ctrl+C] close · Esc back',
    );
    // the page's `Esc` returns to the run's detail on the line it left: one level, the Step class, and it is the page's own key
    expect(tabHostLegend(r.state).exit).toBe(NODE_KEYS.back);
    expect(NODE_KEYS.back).toMatchObject({ keys: 'Esc', verb: 'back', class: 'step' });
    r.press('n');
    expect(r.node()?.message).toBe(nodeShowingFirstFailed(1));
    r.press('', DOWN);
    expect(r.node()?.cursor).toBe(1);
    // Caps Lock on is the same key: the message was cleared by the move, so only the N press can put it back.
    r.press('N');
    expect(r.node()?.message).toBe(nodeShowingFirstFailed(1));
    // The node page has no `p`: p answers nothing (no pin message), and the footer it leaves, which is the hint once no message is set, says so.
    r.press('p');
    expect(r.node()?.message, 'p answers nothing on the node page').toBeUndefined();
    expect(store.listPins({ kind: 'run' }), 'and pins nothing').toEqual([]);
    expect(r.text()).toContain('No run is changed here.');
    r.press('', ESC);
    expect(r.node()).toBeUndefined();
  });

  it('says `unavailable` for a node whose record cannot be read, and offers only the keys that work', async () => {
    const r = rig({ loadNode: () => ({ kind: 'unavailable' }) });
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    expect(r.page()).toContain('? unavailable  build');
    expect(r.text()).toContain(ABSENCE_SENTENCES.unavailable);
    // Two rows, each whole at 80 columns: the reason is not the tail of a sentence a narrow terminal cuts.
    const rows = r.text().split('\n');
    expect(rows).toContain('  The record of this node is unavailable.');
    expect(rows).toContain("  Its attempt, or the run's event log, could not be read.");
    expect(tabHostLegendText(r.state)).toBe('←/→ tab · ↑/↓ scroll · [Ctrl+C] close · Esc back');
    r.press('n');
    expect(r.node()?.message).toBe(NODE_NO_ATTEMPT);
  });
});

describe('below the 80×24 floor the legend names the level `Esc` steps back to', () => {
  const SMALL = { columns: 79, terminalRows: 24 };
  const smallLines = (state: TabHostState): string[] =>
    tabHostLines(state, SMALL).map((line) => line.text);
  const HINT = 'Enlarge the terminal.';

  it('says `back to the run` on a node page, `back to the list` on a run’s detail, and `back to Home` only at the list', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    expect(smallLines(r.state), 'a node page: Esc goes back to the run').toEqual([
      HINT,
      'Esc back to the run',
    ]);
    r.press('', ESC);
    expect(r.node(), 'Esc stepped back to the run’s detail').toBeUndefined();
    expect(smallLines(r.state), 'a run’s detail: Esc goes back to the list').toEqual([
      HINT,
      'Esc back to the list',
    ]);
    r.press('', ESC);
    expect(r.state.history?.detail, 'Esc stepped back to the list').toBeUndefined();
    expect(smallLines(r.state), 'the list: Esc leaves the screen for the Home').toEqual([
      HINT,
      'Esc / [Ctrl+C] back to Home',
    ]);
  });
});

describe('the node order follows the frozen snapshot', () => {
  it('lists the nodes that ran in the order they ran, then the workflow`s unreached nodes in its own order, and numbers a node by the workflow', async () => {
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.reversed);
    const rows = r.state.history?.detail?.read?.model.rows ?? [];
    expect(rows.map((row) => row.nodeId)).toEqual(['review', 'build', 'plan', 'ship']);
    const places: string[] = [];
    for (const label of ['review', 'build', 'plan']) {
      r.moveTo(label);
      r.press('', ENTER);
      places.push(`${label}: ${r.page()[1] ?? ''}`);
      r.press('', ESC);
    }
    expect(places).toEqual([
      'review: Order in the workflow: 3 of 4  ·  type agent',
      'build: Order in the workflow: 2 of 4  ·  type agent',
      'plan: Order in the workflow: 1 of 4  ·  type agent',
    ]);
  });

  it('lists a node of the workflow that has no record as pending after the others, opens it as a short page, and says why in the words of its state', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'ship');
    expect(r.page()).toEqual([
      '○ pending  ship',
      'Order in the workflow: 4 of 4  ·  type transform',
      ABSENCE_SENTENCES.didNotRun,
      `Tokens ${ABSENCE_SENTENCES.didNotRun}  ·  cost ${ABSENCE_SENTENCES.didNotRun}`,
      `Tool activity: ${ABSENCE_SENTENCES.didNotRun}`,
      `Output: ${ABSENCE_SENTENCES.didNotRun}`,
    ]);
    const running = rig();
    await running.openNode(FIXTURE_RUN_IDS.running, 'ship');
    expect(running.page()[2]).toBe(ABSENCE_SENTENCES.notYetRun);
  });

  it('shows the order as unavailable, and the type the run recorded, when the snapshot cannot be read', async () => {
    const r = rig({ snapshot: () => undefined });
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    expect(r.page()[1]).toBe(
      `Order in the workflow: ${ABSENCE_SENTENCES.unavailable}  ·  type agent`,
    );
    expect(r.page().some((line) => line.startsWith('Authored:'))).toBe(false);
    // Without the snapshot the table has only the nodes the run recorded, and says nothing of the others.
    expect(r.state.history?.detail?.read?.model.rows.map((row) => row.nodeId)).toEqual([
      'plan',
      'build',
      'review',
    ]);
  });

  it('keeps every node`s label in the table at 80 columns: a long figure costs the row that figure, never the label', async () => {
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.failed);
    const rows = r
      .text()
      .split('\n')
      .filter((line) => /(completed|failed|pending)\s+\S+/u.test(line) && line.includes('attempt'));
    expect(rows.map((line) => /(?:completed|failed|pending)\s+(\S+)/u.exec(line)?.[1])).toEqual([
      'plan',
      'build',
      'review',
      'ship',
    ]);
    for (const line of rows) {
      expect(line, 'no row lost its label to a cut').not.toContain('…');
      expect(displayWidth(line)).toBeLessThanOrEqual(usableColumns(80));
    }
    // The cost of `build` is a long sentence; at 80 columns it does not fit beside the label, and the node page has it whole.
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    expect(r.page().some((line) => line.includes('cost $0.0000 known; usage unverified'))).toBe(
      true,
    );
  });

  it('never draws an amount of an unverified run without saying so: the header and a node row, at 80 columns and wider', async () => {
    // The fixture log has no `cost:coverage_started`, so its usage is unverified (RUNDETAIL-1): a figure is drawn whole with its
    // qualifier, or a row drops the figure; it is never drawn as a bare amount, and a width never cuts the qualifier off a figure.
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.failed);
    expect(r.state.history?.detail?.read?.model.header.costText).toContain('usage unverified');
    const drawn = (columns: number): string[] =>
      tabHostLines(r.state, { columns, terminalRows: 24 })
        .map((line) => line.text)
        .filter((line) => /\$\d/u.test(line));
    for (const columns of [80, 100, 160]) {
      const lines = drawn(columns);
      expect(lines.length, `the header figure at ${String(columns)} columns`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `at ${String(columns)} columns`).toContain('usage unverified');
      }
    }
    // Wide enough, a node row draws its own figure, with the qualifier beside it.
    expect(drawn(160).filter((line) => /completed\s+build/u.test(line))).toHaveLength(1);
  });

  it('is the same order the loaders were given: FIXTURE_NODES is the authored list', () => {
    expect(FIXTURE_NODES).toEqual(['plan', 'build', 'review', 'ship']);
  });
});

describe('n jumps to the first failed attempt', () => {
  it('on a run: to the first node whose LAST attempt failed, skipping a node that failed and was retried to success', async () => {
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.failed);
    // `build` failed on attempt 1 and was retried to success; it is the table's second row and is not what `n` finds.
    const rows = r.state.history?.detail?.read?.model.rows ?? [];
    expect(rows.find((row) => row.nodeId === 'build')).toMatchObject({
      status: 'completed',
      attemptCount: 2,
    });
    r.press('n');
    expect(r.selected()).toContain('review');
    expect(r.state.history?.detail?.cursor).toBeGreaterThan(0);
  });

  it('on a run with no failed node: says so and moves nothing', async () => {
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.reversed);
    const cursor = r.state.history?.detail?.cursor;
    r.press('n');
    expect(r.state.history?.detail?.message).toBe('No node of this run ended failed.');
    expect(r.state.history?.detail?.cursor).toBe(cursor);
    r.press('', DOWN);
    expect(r.state.history?.detail?.message, 'the next key drops the sentence').toBeUndefined();
  });

  it('on a node that failed on every attempt: shows the first attempt that failed, with that attempt`s own record', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'review');
    // The node page opens on the last attempt, whose end event closed it.
    expect(r.page()).toContain('Tool activity (attempt 2)');
    expect(includesLine(r.page(), ABSENCE_SENTENCES.noResultRecorded)).toBe(true);
    r.press('n');
    expect(r.node()?.message).toBe(nodeShowingFirstFailed(1));
    expect(r.page()).toContain('Tool activity (attempt 1)');
    expect(r.page()).toContain(`  ${ABSENCE_SENTENCES.notRecordedForAttempt}`);
    expect(r.loadNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeId: 'review', attemptNumber: 1 }),
    );
    expect(r.node()?.cursor).toBe(0);
    // Already showing it: no second read.
    const calls = r.loadNode.mock.calls.length;
    r.press('n');
    expect(r.loadNode.mock.calls).toHaveLength(calls);
  });

  it('n skips a node that was retried and then succeeded: its failed attempt is not left failed, so nothing is read and the page stays', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
    const calls = r.loadNode.mock.calls.length;
    const before = r.node();
    expect(
      before?.load.kind === 'ready' && before.load.detail.model.attempts.map((a) => a.status),
    ).toEqual(['failed', 'completed']);
    r.press('n');
    expect(r.node()?.message).toBe(NODE_RETRIED_OK);
    expect(r.loadNode.mock.calls.length, 'no attempt was read').toBe(calls);
    expect(r.page()).toContain('Tool activity (attempt 2)');
    expect(r.node()?.load).toBe(before?.load);
  });

  it('says no attempt failed for a node that never did, and shows the fault when the attempt cannot be read', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.failed, 'plan');
    r.press('n');
    expect(r.node()?.message).toBe(NODE_NO_FAILED);

    const faulty = rig({
      loadNode: (request) =>
        request.attemptNumber === undefined
          ? createNodeDetailLoader({ reader, loadSnapshot: () => FIXTURE_SNAPSHOT })(request)
          : { kind: 'unavailable' },
    });
    await faulty.openNode(FIXTURE_RUN_IDS.failed, 'review');
    faulty.press('n');
    expect(faulty.node()?.message).toBe(NODE_FAULT);
    expect(faulty.page()).toContain('Tool activity (attempt 2)');

    const throwing = rig({
      loadNode: (request) => {
        if (request.attemptNumber !== undefined) throw new Error('the database is closed');
        return createNodeDetailLoader({ reader, loadSnapshot: () => FIXTURE_SNAPSHOT })(request);
      },
    });
    await throwing.openNode(FIXTURE_RUN_IDS.failed, 'review');
    throwing.press('n');
    expect(throwing.node()?.message).toBe(NODE_FAULT);
  });

  it('names the first failed attempt only for a node whose last attempt failed', () => {
    const a = (attempt: number, status: string) => ({ attempt, status });
    expect(firstFailedAttempt([a(1, 'failed'), a(2, 'failed')])).toBe(1);
    expect(firstFailedAttempt([a(1, 'completed'), a(2, 'failed')])).toBe(2);
    expect(firstFailedAttempt([a(1, 'failed'), a(2, 'completed')])).toBeUndefined();
    expect(firstFailedAttempt([a(1, 'failed'), a(2, 'failed'), a(3, 'completed')])).toBeUndefined();
    expect(firstFailedAttempt([a(1, 'completed')])).toBeUndefined();
    expect(firstFailedAttempt([a(1, 'stopped')])).toBeUndefined();
    expect(firstFailedAttempt([])).toBeUndefined();
  });
});

describe('Enter on the run detail', () => {
  it('opens nothing on a line that is not a node row, and says where to press it', async () => {
    const r = rig();
    await r.openRun(FIXTURE_RUN_IDS.failed);
    expect(r.state.history?.detail?.cursor).toBe(0);
    r.press('', ENTER);
    expect(r.node()).toBeUndefined();
    expect(r.state.history?.detail?.message).toBe(NODE_NOT_A_NODE);
    expect(r.loadNode).not.toHaveBeenCalled();
  });

  it('says so when the session cannot read a node, and when the read fails', async () => {
    const without = rig({ withoutLoadNode: true });
    await without.openRun(FIXTURE_RUN_IDS.failed);
    without.moveTo('plan');
    without.press('', ENTER);
    expect(without.state.history?.detail?.message).toBe(NODE_NOT_HERE);

    const throwing = rig({
      loadNode: () => {
        throw new Error('the database is closed');
      },
    });
    await throwing.openRun(FIXTURE_RUN_IDS.failed);
    throwing.moveTo('plan');
    throwing.press('', ENTER);
    expect(throwing.state.history?.detail?.message).toBe(NODE_FAULT);
    expect(throwing.node()).toBeUndefined();
  });

  it('asks for the node the cursor is on, by its raw id, in a run whose end is held as finished', async () => {
    const r = rig({ held: [FIXTURE_RUN_IDS.running] });
    await r.openRun(FIXTURE_RUN_IDS.running);
    r.moveTo('build');
    r.press('', ENTER);
    expect(r.loadNode).toHaveBeenCalledWith({
      runId: FIXTURE_RUN_IDS.running,
      nodeId: 'build',
      terminalHeld: true,
    });
    expect(r.page().some((line) => line.includes(ABSENCE_SENTENCES.didNotFinish))).toBe(true);
    expect(r.page().some((line) => line.includes(ABSENCE_SENTENCES.inProgress))).toBe(false);
  });
});

describe('p on the run detail pins the run', () => {
  const runKey = (runId: string) => ({ kind: 'run', projectRoot: '', ref: runId });

  it('pins under the run`s canonical key, shows the mark in the header, and unpins with the next p', async () => {
    const r = rig();
    await r.openFromList(FIXTURE_RUN_IDS.failed);
    r.press('p');
    expect(store.listPins({ kind: 'run' })).toMatchObject([runKey(FIXTURE_RUN_IDS.failed)]);
    expect(r.state.history?.detail?.message).toBe('Pinned 11111111.');
    expect(r.lines()[2]?.text).toContain('★ pinned');
    r.press('p');
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    expect(r.state.history?.detail?.message).toBe('Unpinned 11111111.');
    expect(r.lines()[2]?.text).not.toContain('★ pinned');
  });

  it('is read again behind the detail: the list shows the pin when the person goes back, on the same run', async () => {
    const r = rig();
    await r.openFromList(FIXTURE_RUN_IDS.failed);
    r.press('p');
    r.press('', ESC);
    expect(r.state.history?.detail).toBeUndefined();
    expect(r.text()).toContain('★ pinned');
    expect(r.state.history?.read?.pinned).toHaveLength(1);
    expect(r.selected()).toContain('11111111');
  });

  it('is the detail`s key and not the node page`s: p on a node page pins nothing, p on the detail it returns to does', async () => {
    const r = rig();
    await r.openFromList(FIXTURE_RUN_IDS.failed);
    r.moveTo('plan');
    r.press('', ENTER);
    expect(r.node()).toBeDefined();
    r.press('p');
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    r.press('', ESC);
    r.press('p');
    expect(store.listPins({ kind: 'run' })).toHaveLength(1);
  });

  it('says why at the cap and writes nothing, and says it when there is no store', async () => {
    for (let index = 0; index < MAX_RUN_PINS; index += 1)
      store.pinItem({ kind: 'run', projectRoot: '', ref: `r${String(index)}`, at: index });
    const full = rig();
    await full.openFromList(FIXTURE_RUN_IDS.failed);
    full.press('p');
    // The store holds fifty run pins and no workflow pin: the sentence names both counts, as the `/workflows` popup's does.
    expect(full.state.history?.detail?.message).toBe(
      `Cannot pin 11111111: ${String(MAX_RUN_PINS)} is the limit; ${String(MAX_RUN_PINS)} stored, 0 of them workflows.`,
    );
    expect(store.listPins()).toHaveLength(MAX_RUN_PINS);

    const none = rig({ withoutPins: true });
    await none.openFromList(FIXTURE_RUN_IDS.failed);
    none.press('p');
    expect(none.state.history?.detail?.message).toBe(PIN_UNAVAILABLE);
  });
});

describe('every absence sentence is the one the reference lists', () => {
  /**
   * One scenario per sentence: a page, or the lines of one, that must say it. The scenarios and the reference are compared both ways below,
   * so a sentence added to the reference without a page that says it fails, and so does a page that says a sentence the reference lacks.
   */
  const scenarios: Readonly<Record<string, () => Promise<string[]>>> = {
    [ABSENCE_SENTENCES.notRecorded]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
      return r.page().filter((line) => line.startsWith('Tokens'));
    },
    [ABSENCE_SENTENCES.didNotRun]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.reversed, 'ship');
      return r.page().filter((line) => line.startsWith('Tokens'));
    },
    [ABSENCE_SENTENCES.didNotFinish]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.stopped, 'build');
      return r.page().filter((line) => line.startsWith('Tokens'));
    },
    [ABSENCE_SENTENCES.inProgress]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.running, 'build');
      return r.page().filter((line) => line.startsWith('Tokens'));
    },
    [ABSENCE_SENTENCES.notYetRun]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.running, 'ship');
      return r.page().filter((line) => line.startsWith('Tokens') || line === 'not yet run');
    },
    [ABSENCE_SENTENCES.notRecordedOlderLog]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
      return r.page().filter((line) => line.startsWith('  not recorded'));
    },
    [ABSENCE_SENTENCES.notRecordedForAttempt]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.failed, 'review');
      r.press('n');
      return r.page().filter((line) => line.startsWith('  not recorded'));
    },
    [ABSENCE_SENTENCES.noResultRecorded]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.failed, 'review');
      return r.page().filter((line) => line.includes('run_command'));
    },
    [ABSENCE_SENTENCES.noToolCalls]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.reversed, 'build');
      return r.page().filter((line) => line.startsWith('  no tool'));
    },
    [ABSENCE_SENTENCES.noOutput]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.failed, 'review');
      return r.page().slice(r.page().indexOf('Output (attempt 2)') + 1);
    },
    [ABSENCE_SENTENCES.emptyOutput]: async () => {
      client.sqlite
        .prepare(
          "UPDATE step_executions SET output_json = '\"\"' WHERE run_id = ? AND node_id = 'plan'",
        )
        .run(FIXTURE_RUN_IDS.reversed);
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
      return r.page().slice(r.page().indexOf('Output (attempt 1)') + 1);
    },
    [ABSENCE_SENTENCES.skipped]: async () => {
      const r = rig();
      await r.openNode(FIXTURE_RUN_IDS.reversed, 'ship');
      return r.page().filter((line) => line.startsWith('skipped'));
    },
    [ABSENCE_SENTENCES.unavailable]: async () => {
      const r = rig({ loadNode: () => ({ kind: 'unavailable' }) });
      await r.openNode(FIXTURE_RUN_IDS.failed, 'build');
      return r.page();
    },
    // The two the run's detail says (the header's error line and the empty node table), drawn on the detail's own page.
    [ABSENCE_SENTENCES.noMessageRecorded]: async () => {
      client.sqlite
        .prepare('UPDATE runs SET error_json = ? WHERE id = ?')
        .run(JSON.stringify({ code: 'tool_failed' }), FIXTURE_RUN_IDS.failed);
      const r = rig();
      await r.openRun(FIXTURE_RUN_IDS.failed);
      return r.lines().map((line) => line.text);
    },
    [ABSENCE_SENTENCES.noNodeRecorded]: async () => {
      const r = rig({ snapshot: () => undefined });
      await r.openRun(FIXTURE_RUN_IDS.empty);
      return r.lines().map((line) => line.text);
    },
  };

  it('has a page for every sentence the reference lists, and lists every sentence a page can say', () => {
    const reference = readAbsenceReference().sentences;
    expect([...Object.keys(scenarios)].sort()).toEqual([...reference].sort());
  });

  it.each(Object.entries(scenarios))(
    'draws `%s` exactly as the reference spells it',
    async (sentence, scenario) => {
      const lines = await scenario();
      expect(readAbsenceReference().sentences).toContain(sentence);
      expect(figuresOf(lines), `${sentence} in ${JSON.stringify(lines)}`).toContain(sentence);
    },
  );

  it('spells the four ways a tool call ends as the reference does, with the call`s own duration where it has one', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.reversed, 'review');
    const rows = (r.node()?.lines ?? []).filter(
      (line) => line.kind === 'row' && line.right !== undefined,
    );
    const outcomes = rows
      .filter((line) => /^ {2}(read_file|list_dir|write_file|run_command)$/u.test(line.left))
      .map((line) => line.right);
    const spelled = readAbsenceReference().toolOutcomes.map((template) =>
      template.replace('<duration>', template.startsWith('ok') ? '12ms' : '340ms'),
    );
    expect(outcomes.sort()).toEqual(spelled.sort());
  });
});

describe('what an output was cut or masked by is said where a narrow terminal still shows it', () => {
  const SECRET = `sk-ant-api03-${'B'.repeat(40)}`;

  /** The reversed run's `plan` node with an output that holds a secret and runs past the 40-line bound, opened on the page. */
  async function openLongMaskedOutput() {
    const r = rig();
    // The secret comes last: the scrubber reads a line break after a key as a continuation and would mask the lines after it too.
    const lines = [
      ...Array.from({ length: 100 }, (_, index) => `line-${String(index + 1)}`),
      `held ${SECRET}`,
    ];
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(JSON.stringify(lines.join('\n')), FIXTURE_RUN_IDS.reversed);
    await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
    return r;
  }

  it('at 80 columns a masked and shortened output shows both words, on a row of its own under the heading', async () => {
    const r = await openLongMaskedOutput();
    const lines = r.node()?.lines ?? [];
    const heading = lines.findIndex(
      (line) => line.kind === 'heading' && line.left.startsWith('Output'),
    );
    expect(heading).toBeGreaterThan(0);
    expect(lines[heading]?.right, 'the heading carries no notes of its own').toBeUndefined();
    expect(lines[heading + 1]).toMatchObject({ kind: 'notice' });
    // Put the cursor on the notice, so the 80-column window draws it.
    for (let index = 0; index < heading + 1; index += 1) r.press('', DOWN);
    const drawn = r.lines().map((line) => line.text);
    expect(drawn.some((line) => line.includes('masked · shortened'))).toBe(true);
    for (const line of drawn) expect(displayWidth(line)).toBeLessThanOrEqual(usableColumns(80));
    expect(r.text()).not.toContain('sk-ant-api03');
  });

  it('says only `masked` when only that happened, and nothing when neither did', async () => {
    const masked = rig();
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(JSON.stringify(`held ${SECRET}`), FIXTURE_RUN_IDS.reversed);
    await masked.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
    expect(masked.page().filter((line) => line.trim() === 'masked')).toHaveLength(1);
    expect(masked.page().join('\n')).not.toContain('shortened');
    const plain = rig();
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(JSON.stringify('plain'), FIXTURE_RUN_IDS.reversed);
    await plain.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
    expect(plain.page().join('\n')).not.toMatch(/masked|shortened/u);
  });

  it('draws the notice a log longer than the pages read leaves, and none for a log that was read whole', async () => {
    const partial = createNodeDetailLoader({
      reader,
      loadSnapshot: () => FIXTURE_SNAPSHOT,
      eventPage: 1,
      maxPages: 1,
    });
    const cut = rig({ loadNode: partial });
    await cut.openNode(FIXTURE_RUN_IDS.failed, 'build');
    expect(cut.page()).toContain(NODE_LOG_PARTIAL);
    // It is a line of the page near its top, so the first screen draws it.
    expect(
      cut.lines().some((line) => line.kind === 'notice' && line.text.includes(NODE_LOG_PARTIAL)),
    ).toBe(true);
    const whole = rig();
    await whole.openNode(FIXTURE_RUN_IDS.failed, 'build');
    expect(whole.page()).not.toContain(NODE_LOG_PARTIAL);
  });
});

describe('no value reaches a line raw', () => {
  const ESC_CHAR = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const RLO = String.fromCharCode(0x202e);
  const RLI = String.fromCharCode(0x2067);
  const ALM = String.fromCharCode(0x061c);
  const SECRET = `sk-ant-api03-${'A'.repeat(40)}`;
  const BIDI = new RegExp('[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]', 'u');
  const controls = `${ESC_CHAR}[31mred${ESC_CHAR}[0m ${ESC_CHAR}]0;title${BEL} ${RLO}drow${RLI}x${ALM}`;
  const hostile = `${SECRET} ${controls}`;

  const at = '2026-11-23T10:00:00.000Z';
  const base = { runId: 'r', timestamp: at };

  /**
   * A failed node whose stored output, error and tool trace all carry a secret shape, an escape and a bidi control. `message` and `note` stand
   * in for the error's message and the output's `note` where a test needs other text there.
   */
  function hostilePage(message = `msg ${hostile}`, note = hostile): NodeTabState {
    const detail: StepDetailRecord = {
      nodeId: 'x',
      nodeType: 'agent',
      status: 'failed',
      attemptNumber: 1,
      costMicrocents: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 10,
      cachedTokens: 0,
      outputJson: JSON.stringify({ note, [`k ${hostile}`]: 'v', nested: [hostile] }),
      outputByteLength: 1,
      errorJson: JSON.stringify({
        code: `code ${hostile}`,
        message,
        // The error's node id is text from the history file: a key-shaped one is masked, not only cleaned of its controls.
        nodeId: `n ${hostile}`,
      }),
      errorByteLength: 1,
    };
    const trace = { toolId: `tool ${hostile}`, ok: true, resultRecorded: true, durationMs: 4 };
    const terminal: RunEvent = Object.assign(
      {},
      {
        type: 'node:failed' as const,
        ...base,
        sequenceNumber: 2,
        nodeId: 'x',
        error: { code: 'tool_failed' as const, message: 'm', retryable: false },
        attemptNumber: 1,
      },
      { toolActivity: [trace] },
    );
    const started: RunEvent = {
      type: 'node:started',
      ...base,
      sequenceNumber: 1,
      nodeId: 'x',
      nodeType: 'agent',
    };
    const attempt: StepSummaryRecord = detail;
    const model = buildNodeDetailModel({
      detail,
      attempts: [attempt],
      events: [started, terminal],
      // The authored agent and model come out of the frozen snapshot (a file the project can change): both are scrubbed whole, as a stored
      // value is, so a key-shaped agent name is masked and not only cleaned of its controls.
      authored: { agentSlug: `agent ${hostile}`, model: `model ${controls}` },
      runFinished: true,
    });
    const row: NodeRow = buildRunDetailModel({
      run: {
        id: 'r',
        workflowId: 'w',
        status: 'failed',
        executionMode: 'local',
        triggerType: 'manual',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        createdAt: at,
        updatedAt: at,
        outputJson: null,
        outputByteLength: null,
        errorJson: null,
        errorByteLength: null,
      },
      steps: [attempt],
      events: [started, terminal],
    }).rows[0] as NodeRow;
    return openNodeTab('r', row, {
      kind: 'ready',
      detail: { runId: 'r', nodeId: 'x', model, attemptNumbers: [1], eventsComplete: true },
    });
  }

  it('never shows a secret shape, an escape or a bidi control from an output, an error, a tool id or an authored name', () => {
    const state = hostilePage();
    const drawn = nodeBody(state, 98, 500)
      .map((line) => line.text)
      .join('\n');
    const kept = state.lines.map((line) => `${line.left} ${line.right ?? ''}`).join('\n');
    for (const text of [drawn, kept]) {
      expect(text).not.toContain('sk-ant-api03');
      expect(text).not.toContain(ESC_CHAR);
      expect(text).not.toContain(BEL);
      expect(BIDI.test(text), 'a bidi control reached the page').toBe(false);
    }
    // The page did show those values, masked: what is left of them is there.
    expect(drawn).toContain('REDACTED');
    expect(drawn).toContain('tool ');
    expect(drawn).toContain('masked');
  });

  it('draws an error’s message with the host’s own glyphs blanked, and an output and a message through the screen filter before they are laid out', () => {
    const FILLER = String.fromCodePoint(0x115f);
    const state = hostilePage(`✓ forged ❯ row │ box${FILLER}after`, `out${FILLER}put ${FILLER}`);
    const rows = nodeBody(state, 98, 500).map((line) => line.text);
    const message = rows.find((row) => row.includes('forged'));
    expect(message, 'the message is drawn').toBeDefined();
    // The host's status glyph, its selection marker and a box-drawing stroke the message wrote are blanked: no row of the page is the message's own.
    expect(message).not.toMatch(/[✓❯│]/u);
    expect(message).toContain('boxafter');
    const output = rows.find((row) => row.includes('output'));
    expect(output, 'the output is drawn with its filler dropped').toBeDefined();
    for (const row of rows) expect(row, 'a Hangul filler reached the page').not.toContain(FILLER);
  });

  it('masks the whole output of a node whose id labels a credential, on the page a person reads and in the lines it keeps, and says it masked', () => {
    const OPAQUE = 'opaqueNODEvalue';
    const at2 = '2026-11-23T10:00:00.000Z';
    const detail: StepDetailRecord = {
      nodeId: 'x-api-key',
      nodeType: 'agent',
      status: 'completed',
      attemptNumber: 1,
      costMicrocents: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 10,
      cachedTokens: 0,
      outputJson: JSON.stringify(OPAQUE),
      outputByteLength: 1,
      errorJson: null,
      errorByteLength: null,
    };
    const attempt: StepSummaryRecord = detail;
    const row = buildRunDetailModel({
      run: {
        id: 'r',
        workflowId: 'w',
        status: 'completed',
        executionMode: 'local',
        triggerType: 'manual',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        createdAt: at2,
        updatedAt: at2,
        outputJson: null,
        outputByteLength: null,
        errorJson: null,
        errorByteLength: null,
      },
      steps: [attempt],
      events: [],
    }).rows[0];
    if (row === undefined) throw new Error('the run detail lists the node');
    const model = buildNodeDetailModel({
      detail,
      attempts: [attempt],
      events: [],
      runFinished: true,
    });
    const state = openNodeTab('r', row, {
      kind: 'ready',
      detail: { runId: 'r', nodeId: 'x-api-key', model, attemptNumbers: [1], eventsComplete: true },
    });
    const drawn = nodeBody(state, 78, 500)
      .map((line) => line.text)
      .join('\n');
    const kept = state.lines.map((line) => `${line.left} ${line.right ?? ''}`).join('\n');
    for (const text of [drawn, kept])
      expect(text, 'the value of a credential-named node').not.toContain(OPAQUE);
    expect(drawn).toContain('[REDACTED]');
    expect(drawn).toContain('masked');
    // The same value under a node id that labels nothing is shown as it is: the mask is the id's doing, not the page's habit.
    const plainModel = buildNodeDetailModel({
      detail: { ...detail, nodeId: 'writer' },
      attempts: [attempt],
      events: [],
      runFinished: true,
    });
    const plain = openNodeTab('r', row, {
      kind: 'ready',
      detail: {
        runId: 'r',
        nodeId: 'writer',
        model: plainModel,
        attemptNumbers: [1],
        eventsComplete: true,
      },
    });
    expect(
      nodeBody(plain, 78, 500)
        .map((line) => line.text)
        .join('\n'),
    ).toContain(OPAQUE);
  });

  it('never shows a secret shape from a stored output, error or trace on the page a person opens', async () => {
    const r = rig();
    await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
    const raw = `{"note":"${SECRET}","${SECRET}":"v","x-api-key":"abc"}`;
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(raw, FIXTURE_RUN_IDS.reversed);
    r.press('', ESC);
    r.moveTo('plan');
    r.press('', ENTER);
    const text = r.page().join('\n');
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('"abc"');
    expect(text).toContain('masked');
  });

  it('bounds an output at forty lines and 4,000 code points, says it was shortened, and refuses a stored document over 1 MiB without reading any of it', async () => {
    const r = rig();
    const lines = Array.from({ length: 100 }, (_, index) => `line-${String(index + 1)}`).join('\n');
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(JSON.stringify(lines), FIXTURE_RUN_IDS.reversed);
    await r.openNode(FIXTURE_RUN_IDS.reversed, 'plan');
    let page = r.page().join('\n');
    expect(page).toContain('line-40');
    expect(page).not.toContain('line-41');
    expect(page).toContain('shortened');

    const big = `{"v":"${'a'.repeat(1_048_576)}"}`;
    client.sqlite
      .prepare("UPDATE step_executions SET output_json = ? WHERE run_id = ? AND node_id = 'plan'")
      .run(big, FIXTURE_RUN_IDS.reversed);
    r.press('', ESC);
    r.moveTo('plan');
    r.press('', ENTER);
    page = r.page().join('\n');
    expect(page).toContain(`output too large to preview (${String(Buffer.byteLength(big))} bytes)`);
    expect(page).not.toContain('aaaa');
  });
});
