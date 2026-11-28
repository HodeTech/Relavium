import './force-color.js';

import { createClient, runMigrations, createRunHistoryReader, type DbClient } from '@relavium/db';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHistorySource } from '../../history/history-source.js';
import { createNodeDetailLoader } from '../../history/node-detail-source.js';
import {
  FIXTURE_RUN_IDS,
  FIXTURE_SNAPSHOT,
  seedFixtureRuns,
} from '../../history/node-run-fixture.js';
import { createRunDetailLoader } from '../../history/run-detail-source.js';
import type { HomeRunRow, HomeSnapshot } from '../../home/home-store.js';
import { withoutStyles } from './harness-util.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeController,
  type HomeControllerState,
} from './home-controller.js';
import type { HistoryPort } from './tab-host-history.js';

/**
 * `Enter` on a screen opened from a focused strip row ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6; review finding HOMECTL-1), through a mounted `RootApp` with real stdin bytes. The gate that swallows an `Enter` whose row the person has
 * not seen yet reads the measured frame of the LANDING; a screen in the slot draws no landing, so that frame is never committed while it is
 * open. A run focus stays through the screen it opened (the way back lands on the row), so without a `current.screen === undefined` in the
 * gate every `Enter` on a screen opened from a run row was swallowed: the run's detail could not open a node. The tests of the controller
 * call `handleKey` and bypass the gate, which is why they never saw it; this file owns the gate.
 */
afterEach(cleanup);

const NOW_MS = Date.parse('2026-11-23T01:00:00.000Z');
const DOWN = '\u001b[B';

const failedRun: HomeRunRow = {
  runId: FIXTURE_RUN_IDS.failed,
  workflowSlug: 'ship-it',
  status: 'failed',
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
};
const SNAPSHOT: HomeSnapshot = {
  failedRuns: [failedRun],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 1, sessions: 0, runs: 0 },
  isEmpty: false,
};

let client: DbClient;
beforeEach(async () => {
  client = createClient(':memory:');
  runMigrations(client.db);
  await seedFixtureRuns(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

/** The Home over the real run loaders and a real (in-memory) history database: the failed run of the fixture is the strip's one row. */
function mount() {
  const reader = createRunHistoryReader(client.db);
  const loadSnapshot = (): string => FIXTURE_SNAPSHOT;
  const history: HistoryPort = {
    ...createHistorySource({
      reader,
      listRunPins: () => [],
      projectRoot: '/work/project',
      now: () => NOW_MS,
    }),
    loadDetail: createRunDetailLoader({
      reader,
      projectRoot: '/work/project',
      listHeld: () => Promise.resolve([]),
      loadSnapshot,
    }),
    loadNode: createNodeDetailLoader({ reader, loadSnapshot }),
  };
  const onError = vi.fn();
  const real = createHomeController({
    startChat: () => new Promise<never>(() => {}),
    homeStore: { read: () => SNAPSHOT },
    history,
    schedule: () => () => {},
    onExit: vi.fn(),
    onError,
  });
  // The measured-frame oracle the gate itself reads: `RootApp` hands it to the controller, and the test reads it from there, so `Enter`
  // is sent only once the frame with the focused row is on screen (a frame in `lastFrame()` is not yet an acknowledged one).
  let visible: ((state: HomeControllerState) => boolean) | undefined;
  const controller: HomeController = {
    ...real,
    bindHomeFrame: (probe) => {
      visible = probe;
      real.bindHomeFrame(probe);
    },
  };
  const landingFrameAcknowledged = (): boolean => visible?.(controller.getSnapshot()) === true;
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => NOW_MS}
      color={false}
      getSize={() => ({ cols: 100, rows: 30 })}
      subscribeResize={() => () => {}}
    />,
  );
  const detailOf = () => {
    const screen = controller.getSnapshot().screen;
    return screen?.kind === 'tab-host' ? screen.host.history?.detail : undefined;
  };
  return {
    controller,
    harness,
    onError,
    detailOf,
    landingFrameAcknowledged,
    frame: () => withoutStyles(harness.lastFrame() ?? ''),
    selectedLine: () =>
      withoutStyles(harness.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.startsWith('> ')) ?? '',
  };
}

/** Poll until `predicate` holds and FAIL if it never does (a bare wait that gives up quietly would assert nothing). */
const until = (predicate: () => boolean, timeout = 4000): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate())
        throw new Error(`the condition did not become true: ${predicate.toString()}`);
    },
    { timeout, interval: 15 },
  );

describe('Enter on a screen opened from a focused failed run', () => {
  it('reaches the screen: the run detail opens a node page, though the strip focus stayed through it', async () => {
    const m = mount();
    // the landing names the failed run (MVP-11 unit 7: `↓ ship-it failed 1h ago`); its row is the work page's
    await until(() => m.frame().includes('ship-it failed'));

    // `↓` onto the failed run: the row is drawn with its marker before `Enter` is sent, so this one is a row the person has seen.
    m.harness.stdin.write(DOWN);
    await until(() => m.frame().includes('> x  ship-it'));
    await until(m.landingFrameAcknowledged);
    expect(m.controller.getSnapshot().stripFocus?.id).toBe(FIXTURE_RUN_IDS.failed);

    // `Enter` on the row opens the run's detail on the History tab: the landing is replaced by a screen.
    m.harness.stdin.write('\r');
    await until(() => m.detailOf()?.phase === 'ready');
    expect(m.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(
      m.controller.getSnapshot().stripFocus?.id,
      'the focus on the run stays while the screen is open: it is the premise of the gate under test',
    ).toBe(FIXTURE_RUN_IDS.failed);
    expect(m.detailOf()?.node, 'no node page yet').toBeUndefined();
    await until(() => m.frame().includes('Nodes (4)'));

    // The detail's cursor starts on its header and moves a line a press; `↓` is the screen's key (the gate holds back only `Enter`).
    for (let presses = 0; !/completed\s+plan/u.test(m.selectedLine()); presses += 1) {
      expect(
        presses,
        `the cursor reached the first node in a few presses\n${m.frame()}`,
      ).toBeLessThan(12);
      const before = m.selectedLine();
      m.harness.stdin.write(DOWN);
      await until(() => m.selectedLine() !== before);
    }

    // `Enter` here is the SCREEN'S key, not the landing's: it must open that node's page, not be taken for the unseen strip row.
    m.harness.stdin.write('\r');
    await until(() => m.detailOf()?.node !== undefined);
    await until(() => m.frame().includes('Order in the workflow: 1 of 4'));
    expect(m.onError).not.toHaveBeenCalled();
  });

  it('still holds back a coalesced ↓ + Enter on the landing: a row the person has not seen is not opened', async () => {
    const m = mount();
    await until(() => m.frame().includes('ship-it failed'));
    // One chunk: the focus moves onto the row and `Enter` arrives with it, before that frame can be on screen.
    m.harness.stdin.write(`${DOWN}\r`);
    await until(() => m.controller.getSnapshot().stripFocus?.id === FIXTURE_RUN_IDS.failed);
    await until(() => m.frame().includes('> x  ship-it'));
    expect(m.controller.getSnapshot().screen, 'the unseen row was not opened').toBeUndefined();
  });
});
