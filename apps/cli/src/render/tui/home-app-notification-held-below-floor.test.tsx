/**
 * A notification is HELD (queued, unspent, not drawn) while the Home cannot draw the row it lives on (MVP-11 unit 7, round 2; `notificationHeld`
 * in `home-app.tsx`): a terminal below the Home's floor (80×24) shows the "too small" card in place of the body, so a notification raised then
 * waits for the terminal to grow back and is shown whole. At the floor itself it is shown at once.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { createNotificationChannel } from '../../popups/notifications.js';
import { settleFrames, withoutStyles } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { snapshotOf } from './home-controller.test-support.js';

afterEach(cleanup);

const SAID = 'Global startup default saved: plan.';

function mount(size: { readonly cols: number; readonly rows: number }) {
  const notifications = createNotificationChannel({ schedule: () => () => {} });
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => snapshotOf({ isEmpty: true }) },
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
      getSize={() => size}
      subscribeResize={() => () => {}}
    />,
  );
  return { notifications, frame: (): string => withoutStyles(harness.lastFrame() ?? '') };
}

describe('a notification raised while the terminal is below the Home’s floor is held', () => {
  it.each([
    [79, 24],
    [80, 23],
    [60, 20],
  ] as const)('at %i×%i it waits in the queue and is not drawn', async (cols, rows) => {
    const m = mount({ cols, rows });
    await settleFrames();
    m.notifications.notify(SAID);
    await settleFrames();
    expect(m.notifications.getSnapshot().queued, 'unspent').toBe(1);
    expect(m.frame()).not.toContain(SAID);
  });

  it('at the floor (80×24) the same notification is shown at once', async () => {
    const m = mount({ cols: 80, rows: 24 });
    await settleFrames();
    m.notifications.notify(SAID);
    await settleFrames();
    expect(m.frame()).toContain(SAID);
  });
});
