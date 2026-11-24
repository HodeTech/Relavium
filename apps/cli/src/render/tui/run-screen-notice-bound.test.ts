/**
 * The run view's notice rows are bounded before they are sanitized and clipped (PR #102 review): `clipLine` measures a line's whole display
 * width first, so a notice of megabytes would cost a walk of all of it on every frame, the cost class the Home's own notice is bounded for
 * (`MAX_HOME_NOTICE_CHARS`). Counted, not timed: the test records what reaches `clipLine`.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RunHostSnapshot } from '../../home/run-host.js';
import { MAX_HOME_NOTICE_CHARS } from './home-notice.js';
import { RUN_SCREEN_NOTICE_WIDTH, runScreenModel } from './run-screen.js';
import { clipLine } from './sheet-frame.js';
import { displayWidth } from './viewport.js';

vi.mock('./sheet-frame.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sheet-frame.js')>();
  return { ...original, clipLine: vi.fn(original.clipLine) };
});

const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};

function shown(notices: readonly string[], columns = 200): readonly string[] {
  return runScreenModel({
    runId: 'run-0001',
    snapshot: RUNNING,
    notices,
    armed: false,
    columns,
    rows: 24,
  }).notices;
}

/** The longest line any `clipLine` call was handed since the spy was last cleared. */
function longestClipped(): number {
  return Math.max(0, ...vi.mocked(clipLine).mock.calls.map(([line]) => line.length));
}

describe('the run view bounds a notice before it clips it', () => {
  it('hands clipLine at most the bound and one ellipsis of a notice of megabytes, and still shows a cut row', () => {
    vi.mocked(clipLine).mockClear();
    const [row] = shown(['word '.repeat(500_000)]); // 2.5 million characters
    expect(longestClipped()).toBeLessThanOrEqual(MAX_HOME_NOTICE_CHARS + 1);
    expect(row?.endsWith('…')).toBe(true);
    expect(displayWidth(row ?? '')).toBeLessThanOrEqual(RUN_SCREEN_NOTICE_WIDTH);
  });

  it('hands a notice of exactly the bound over whole, and cuts a surrogate pair at the bound in neither half', () => {
    vi.mocked(clipLine).mockClear();
    shown(['x'.repeat(MAX_HOME_NOTICE_CHARS)]);
    expect(longestClipped()).toBe(MAX_HOME_NOTICE_CHARS);

    vi.mocked(clipLine).mockClear();
    shown([`${'a'.repeat(MAX_HOME_NOTICE_CHARS - 1)}\u{1F600}b`]); // the pair straddles the bound
    const handed = vi.mocked(clipLine).mock.calls.map(([line]) => line);
    expect(handed).toHaveLength(1);
    expect(handed[0]).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
    );
  });

  it('shows a notice under the bound exactly as before', () => {
    expect(shown(['short note'])).toEqual(['short note']);
  });
});
