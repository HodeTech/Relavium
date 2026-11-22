/**
 * The exit-guard card through a mounted `RootApp` and real stdin bytes
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6): the raw `Ctrl+D`, `Ctrl+Y` and
 * `Ctrl+N` bytes reach the controller in the loaded Home, in the loading echo and in the below-minimum degrade, and the card is
 * drawn in each. `home-exit-guard.test.ts` owns the controller's behaviour; this file owns the wiring above it.
 *
 * The run host and the clock are scripted: no engine is built and no operator home is read.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { settleFrames, waitFor } from './harness-util.js';

afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};

const CTRL_C = '\x03';
const CTRL_D = '\x04';
const CTRL_N = '\x0e';
const CTRL_Y = '\x19';

function mount(options: { size?: { cols: number; rows: number } } = {}) {
  const cancel = vi.fn((): boolean => true);
  const close = vi.fn(() => Promise.resolve());
  const onExit = vi.fn();
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => RUNNING, cancel, close },
    // The leg never settles and the grace never fires: this file proves the wiring, not the wait.
    schedule: () => () => {},
    onExit,
    onError: vi.fn(),
  });
  const size = options.size ?? { cols: 100, rows: 30 };
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
    />,
  );
  return { controller, harness, cancel, close, onExit };
}

describe('the exit-guard card through RootApp', () => {
  it('Ctrl+D on the empty landing opens the card, drawn over the Home with the run row, and the prompt is not offered', async () => {
    const { controller, harness, onExit } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Ctrl+Y stop the run and leave'));
    const frame = harness.lastFrame() ?? '';
    expect(frame).toContain('A workflow run is executing: run-0001.');
    expect(frame).toContain('▶ run-0001');
    expect(frame).not.toContain('Ctrl+C twice to exit');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('Ctrl+N closes it and the Home is back: the prompt hint returns', async () => {
    const { controller, harness, cancel } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    harness.stdin.write(CTRL_N);
    await waitFor(() => controller.getSnapshot().exitGuard === undefined);
    await waitFor(() => (harness.lastFrame() ?? '').includes('Ctrl+C twice to exit'));
    expect(harness.lastFrame()).not.toContain('Ctrl+Y stop the run');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Ctrl+Y cancels the run and the card says it is stopping', async () => {
    const { controller, harness, cancel, onExit } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    harness.stdin.write(CTRL_Y);
    await waitFor(() => (harness.lastFrame() ?? '').includes('Stopping the run…'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.lastFrame()).toContain('within 10 s');
    expect(onExit, 'the leg has not settled and the grace has not run out').not.toHaveBeenCalled();
  });

  it('is drawn in the loading echo, where the first chat is still being built', async () => {
    const { controller, harness } = mount();
    await settleFrames();
    controller.handleKey('h', {});
    controller.handleKey('', { return: true });
    await waitFor(() => controller.getSnapshot().mode === 'loading');
    harness.stdin.write(CTRL_C);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Ctrl+Y stop the run and leave'));
    expect(harness.lastFrame()).not.toContain('Starting chat… · Ctrl+C to exit');
  });

  it('below the 80×24 minimum the card is drawn and its two chords still reach it', async () => {
    const { controller, harness, cancel } = mount({ size: { cols: 60, rows: 20 } });
    await settleFrames();
    harness.stdin.write(CTRL_Y);
    await settleFrames();
    expect(
      cancel,
      'with no card open a Ctrl+Y below the minimum is not delivered at all',
    ).not.toHaveBeenCalled();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Ctrl+Y stop the run and leave'));
    expect(harness.lastFrame()).toContain('Terminal too small (60×20)');
    harness.stdin.write(CTRL_Y);
    await waitFor(() => controller.getSnapshot().exitGuard === 'stopping');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
