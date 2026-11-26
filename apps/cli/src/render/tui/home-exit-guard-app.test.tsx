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
import { settleFrames, waitFor, withoutStyles } from './harness-util.js';
import { glyphOf } from './glyphs.js';
import { HOSTED_RUN_EXIT_BOUND_MS } from './tui-constants.js';

afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
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
  it('Ctrl+D on the empty landing opens the card in the place of the prompt block (the run row with it: the card names the run), and the prompt is not offered', async () => {
    const { controller, harness, onExit } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    const frame = harness.lastFrame() ?? '';
    expect(frame).toContain('A workflow run is executing: run-0001.');
    expect(
      frame,
      'the row stands under the status line, in the block the card replaces',
    ).not.toContain('~ run-0001');
    expect(frame).not.toContain('[Ctrl+C] exit (twice)');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('the title row has a glyph and the words, so the card reads without colour as the other cards do', async () => {
    const { controller, harness } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    const lines = withoutStyles(harness.lastFrame() ?? '').split('\n');
    const title = lines.find((line) => line.includes('A workflow run is executing'));
    expect(title?.trim(), 'a glyph, then the words, on one row').toBe(
      `${glyphOf('warning', true)} A workflow run is executing: run-0001.`,
    );
    await settleFrames(); // the card's exact frame is measured and flushed: only then does Ctrl+Y count
    harness.stdin.write(CTRL_Y);
    await waitFor(() => (harness.lastFrame() ?? '').includes('Stopping the run…'));
    expect(
      withoutStyles(harness.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes('Stopping the run…'))
        ?.trim(),
      'the waiting card has its glyph too',
    ).toBe(`${glyphOf('stopping', true)} Stopping the run…`);
  });

  it('Ctrl+N closes it and the Home is back: the prompt hint returns', async () => {
    const { controller, harness, cancel } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    harness.stdin.write(CTRL_N);
    await waitFor(() => controller.getSnapshot().exitGuard === undefined);
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+C] exit (twice)'));
    expect(harness.lastFrame()).not.toContain('[Ctrl+Y] stop the run');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Ctrl+Y cancels the run and the card says it is stopping', async () => {
    const { controller, harness, cancel, onExit } = mount();
    await settleFrames();
    harness.stdin.write(CTRL_D);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    await settleFrames(); // the card's exact frame is measured and flushed: only then does Ctrl+Y count
    harness.stdin.write(CTRL_Y);
    await waitFor(() => (harness.lastFrame() ?? '').includes('Stopping the run…'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.lastFrame()).toContain(
      `within about ${String(HOSTED_RUN_EXIT_BOUND_MS / 1000)}s`, // the grace and then the host's settle bound
    );
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
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    expect(harness.lastFrame()).not.toContain('Starting chat… · [Ctrl+C] exit');
  });

  it('Ctrl+Y counts in the loading echo too, once that frame is on screen: the echo is measured like the landing', async () => {
    const { controller, harness, cancel } = mount();
    await settleFrames();
    controller.handleKey('h', {});
    controller.handleKey('', { return: true });
    await waitFor(() => controller.getSnapshot().mode === 'loading');
    harness.stdin.write(CTRL_C);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    await settleFrames(); // the echo's exact frame is measured and flushed: only then does Ctrl+Y count
    harness.stdin.write(CTRL_Y);
    await waitFor(() => (harness.lastFrame() ?? '').includes('Stopping the run…'));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('below the 80×24 minimum the loading echo says to resize, with the card drawn in the same degrade as on the landing', async () => {
    const { controller, harness } = mount({ size: { cols: 60, rows: 20 } });
    await settleFrames();
    controller.handleKey('h', {});
    controller.handleKey('', { return: true });
    await waitFor(() => controller.getSnapshot().mode === 'loading');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Starting chat…'));
    expect(harness.lastFrame(), 'the resize line, before any card is open').toContain(
      'Terminal too small (60×20) — resize to at least 80×24.',
    );
    harness.stdin.write(CTRL_C);
    await waitFor(() => controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    const frame = harness.lastFrame() ?? '';
    expect(frame, 'the card and the line that explains why Ctrl+Y answers nothing').toContain(
      'Terminal too small (60×20) — resize to at least 80×24.',
    );
    expect(frame.indexOf('Terminal too small'), 'the line comes before the card').toBeLessThan(
      frame.indexOf('A workflow run is executing'),
    );
  });

  it('at 80×24 or more the loading echo has no resize line', async () => {
    const { controller, harness } = mount({ size: { cols: 80, rows: 24 } });
    await settleFrames();
    controller.handleKey('h', {});
    controller.handleKey('', { return: true });
    await waitFor(() => controller.getSnapshot().mode === 'loading');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Starting chat…'));
    const frame = harness.lastFrame() ?? '';
    // `waitFor` never throws, so the echo must be shown to be on screen before an absence on it means anything.
    expect(frame, 'the loading echo is what is drawn').toContain('Starting chat…');
    expect(frame).not.toContain('Terminal too small');
  });

  it('below the 80×24 minimum the card is drawn, Ctrl+N and Esc still reach it, and Ctrl+Y answers nothing', async () => {
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
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    expect(harness.lastFrame()).toContain('Terminal too small (60×20)');
    // A cancel that cannot be undone needs the card on screen as the person is meant to read it: at 80×24 or more, never in the degrade.
    harness.stdin.write(CTRL_Y);
    await settleFrames();
    expect(controller.getSnapshot().exitGuard, 'the card is still asking').toBe('confirm');
    expect(cancel).not.toHaveBeenCalled();
    harness.stdin.write(CTRL_N);
    await waitFor(() => controller.getSnapshot().exitGuard === undefined);
    expect(cancel).not.toHaveBeenCalled();
  });
});
