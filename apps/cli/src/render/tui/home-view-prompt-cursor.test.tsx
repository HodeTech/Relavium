/**
 * Which prompt has the cursor while the two pages are on screen together (MVP-11 unit 7, round 2; `withoutCursor` in `home-view.tsx`): in the
 * slide between the pages the frame is a window onto both, each with its own prompt row holding the one draft, and only the prompt of the page
 * that is in front draws the cursor cell (the inverse block); the other draws the same text without it. At rest on the landing it is the landing's.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { HomeView } from './home-view.js';

afterEach(cleanup);

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const INVERSE = `${ESC}[7m`;
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const WITH_A_SESSION: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [
    {
      sessionId: 'session-1',
      title: 'A session',
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: new Date(NOW - 3_600_000).toISOString(),
      totalCostMicrocents: 0,
    },
  ],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};

/** The frame's rows that hold the prompt (`> draft`, or the invitation when nothing is typed), each with whether it draws an inverse cell. */
function promptRows(
  page: 'start' | 'work',
  slideOffset: number | undefined,
  text = 'draft',
): readonly boolean[] {
  const view = render(
    <HomeView
      snapshot={WITH_A_SESSION}
      parkedRuns={[]}
      editor={{ text, cursor: text.length }}
      page={page}
      nowMs={NOW}
      cols={80}
      rows={24}
      color={false}
      alternateScreen
      {...(slideOffset === undefined ? {} : { slideOffset })}
    />,
  );
  const rows = (view.lastFrame() ?? '').split('\n');
  view.unmount();
  return rows
    .filter((row) => /^> (draft|e\.g\.|type a message)/u.test(row.replace(SGR, '').trim()))
    .map((row) => row.includes(INVERSE));
}

describe('the cursor is the prompt of the page in front', () => {
  // The window is 23 rows onto the two pages stacked, the landing's prompt row at about row 10 and the work page's 18 rows into the second page:
  // an offset of 10 or less shows the landing's prompt, and one of 19 or more the work page's; never both.
  it('on the landing at rest it is the landing’s prompt', () => {
    expect(promptRows('start', undefined)).toEqual([true]);
  });

  it('on the work page at rest it is the docked prompt', () => {
    expect(promptRows('work', undefined)).toEqual([true]);
  });

  it('while the pages slide to the work page, the landing’s prompt in view has no cursor and the work page’s has it', () => {
    expect(promptRows('work', 6)).toEqual([false]);
    expect(promptRows('work', 22)).toEqual([true]);
  });

  it('while the pages slide to the landing, the work page’s prompt in view has no cursor and the landing’s has it', () => {
    expect(promptRows('start', 22)).toEqual([false]);
    expect(promptRows('start', 6)).toEqual([true]);
  });

  it('with nothing typed the cursor is on the invitation’s first character, and only on the prompt in front', () => {
    expect(promptRows('start', undefined, '')).toEqual([true]);
    expect(promptRows('work', undefined, '')).toEqual([true]);
    expect(promptRows('work', 6, '')).toEqual([false]);
    expect(promptRows('work', 22, '')).toEqual([true]);
    expect(promptRows('start', 22, '')).toEqual([false]);
    expect(promptRows('start', 6, '')).toEqual([true]);
  });
});
