/**
 * The armed `Ctrl+C` is said on the hint row even while a notification is showing (MVP-11 unit 7, round 1: CO75). A notification takes the hint
 * row's place for its few seconds; while the interrupt keymap is armed the row must say `[Ctrl+C] exit (again)` (the second press leaves, and a
 * first press that changes nothing visible is a trap), so the channel is HELD while it is armed: the notification is not spent unseen, and it is
 * shown again, whole, once the armed state ends. On the landing and on the work page, through the real mounted `RootApp` and the real channel.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { createNotificationChannel } from '../../popups/notifications.js';
import type { HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { settleFrames, waitFor, withoutStyles } from './harness-util.js';

afterEach(cleanup);

const SAID = 'Global startup default saved: plan.';
const ARMED = '[Ctrl+C] exit (again)';
const sessionRow = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const SESSIONS: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [sessionRow(1)],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};

function mount() {
  // The notification's own expiry never fires here: what ends it on screen is only what the Home does.
  const notifications = createNotificationChannel({ schedule: () => () => {} });
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => SESSIONS },
    announce: (text) => notifications.notify(text),
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  const harness = render(
    <RootApp
      controller={controller}
      notifications={notifications}
      nowMs={() => 0}
      color={false}
      alternateScreen
      getSize={() => ({ cols: 80, rows: 24 })}
      subscribeResize={() => () => {}}
    />,
  );
  /** The last row of the frame: the hint row of either page. */
  const hintRow = (): string =>
    withoutStyles(harness.lastFrame() ?? '')
      .split('\n')
      .filter((row) => row.trim() !== '')
      .at(-1)
      ?.trim() ?? '';
  return { controller, notifications, harness, hintRow };
}

describe.each(['the landing', 'the work page'] as const)('on %s', (page) => {
  it('a first `Ctrl+C` shows the armed exit over a notification, and the notification comes back whole once it is disarmed', async () => {
    const m = mount();
    await settleFrames();
    if (page === 'the work page') {
      m.harness.stdin.write('\u001b[B');
      await waitFor(() => m.controller.getSnapshot().homePage === 'work');
    }
    m.notifications.notify(SAID);
    await waitFor(() => m.hintRow() === SAID);
    expect(m.hintRow()).toBe(SAID);

    m.harness.stdin.write('\u0003'); // the first Ctrl+C arms
    await waitFor(() => m.hintRow() === ARMED);
    expect(m.hintRow(), 'the second press leaves, and the row says so').toBe(ARMED);
    expect(m.notifications.getSnapshot().queued, 'the notification waits, unspent').toBe(1);

    m.controller.disarmInterrupt(); // any other key ends the armed state
    await waitFor(() => m.hintRow() === SAID);
    expect(m.hintRow()).toBe(SAID);
  });
});
