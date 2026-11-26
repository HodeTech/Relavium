/**
 * The first-run setup that opens by itself and the Home's two pages (MVP-11 unit 7): it opens over the landing only, never over the work page
 * the person went down to and never while the pages slide; everything else of the rule (ADR-0146 §6: no chat, no draft, nothing owning the
 * keyboard) is the same predicate, which `keyless-journey.test.ts` drives through `driveHome`.
 */
import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from './home-store.js';
import { createHomeController } from '../render/tui/home-controller.js';
import { homeClearForFirstRun } from './drive-home.js';

const BUSY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [
    {
      sessionId: 's1',
      workingDir: '/work',
      title: undefined,
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-23T00:00:00.000Z',
      totalCostMicrocents: 0,
    },
  ],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: false,
};

function home(slides: boolean) {
  return createHomeController({
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => BUSY },
    // the slide's frames never fire: the test looks at the Home while it slides
    schedule: () => () => {},
    slideTransitions: slides,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
}

describe('the first-run setup that opens by itself, and the pages', () => {
  it('may open over the landing with an empty composer and nothing open', () => {
    expect(homeClearForFirstRun(home(false).getSnapshot(), false)).toBe(true);
  });

  it('does not open over the work page, at its rows or at its docked prompt', () => {
    const c = home(false);
    c.handleKey('', { downArrow: true });
    expect(c.getSnapshot().homePage).toBe('work');
    expect(homeClearForFirstRun(c.getSnapshot(), false), 'on a row').toBe(false);
    c.handleKey('', { downArrow: true });
    expect(c.getSnapshot().stripFocus, 'the docked prompt').toBeUndefined();
    expect(homeClearForFirstRun(c.getSnapshot(), false), 'on the docked prompt').toBe(false);
    c.handleKey('', { escape: true });
    expect(homeClearForFirstRun(c.getSnapshot(), false), 'back on the landing').toBe(true);
  });

  it('does not open while the pages slide, toward either page', () => {
    const down = home(true);
    down.handleKey('', { downArrow: true });
    expect(down.getSnapshot().slide?.to).toBe('work');
    expect(homeClearForFirstRun(down.getSnapshot(), false)).toBe(false);
    // a slide UP to the landing: the page is already the landing's, the slide is not over
    const up = home(true);
    up.handleKey('', { downArrow: true });
    up.setTerminalSize(80, 24); // a resize ends the slide where it would arrive
    up.handleKey('', { escape: true });
    expect(up.getSnapshot().homePage).toBe('start');
    expect(up.getSnapshot().slide?.to).toBe('start');
    expect(homeClearForFirstRun(up.getSnapshot(), false)).toBe(false);
  });

  it('keeps the rest of the rule: a draft, or a popup open, is not a clear landing', () => {
    const c = home(false);
    expect(homeClearForFirstRun(c.getSnapshot(), true)).toBe(false);
    c.handleKey('a', {});
    expect(homeClearForFirstRun(c.getSnapshot(), false)).toBe(false);
  });
});
