/**
 * An `Enter` that arrives while the pages slide is judged when it is pressed: no frame had shown the page it acts on at rest, so it opens
 * nothing (the live rule: no unseen row is opened). It is still a key of the Home's chord history (`landingKeys.stamp()`), so a card that opens
 * soon after sees it in its quiet gap.
 */
import { describe, expect, it } from 'vitest';

import { createChordHistory } from './chord-guard.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { DOWN, ENTER, sessionRow, snapshotOf } from './home-controller.test-support.js';
import { SLIDE_FRAME_MS } from './home-pages.js';

describe('an Enter dropped while the pages slide is still a key of the chord history', () => {
  it('the landing stamps it: a card that opens soon after sees it as the key before', () => {
    let now = 1_000;
    const history = createChordHistory();
    const controller = createHomeController({
      startChat: () => new Promise<HomeChatSession>(() => {}),
      homeStore: {
        read: () =>
          snapshotOf({
            recentSessions: [sessionRow('s1')],
            totals: { attention: 0, sessions: 1, runs: 0 },
          }),
      },
      resumeChat: () => new Promise<undefined>(() => {}),
      schedule: () => () => {},
      slideTransitions: true,
      now: () => now,
      chordHistory: history,
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
    controller.setTerminalSize(80, 24);
    controller.handleKey('', DOWN);
    expect(controller.getSnapshot().slide, 'the pages slide').toBeDefined();
    const before = history.previousKeyAt;
    now = 1_000 + SLIDE_FRAME_MS;
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().stripFocus?.id, 'dropped: nothing opened').toBe('s1');
    expect(history.previousKeyAt, 'the dropped Enter is the last key the history heard').toBe(now);
    expect(history.previousKeyAt).toBeGreaterThan(before);
  });
});
