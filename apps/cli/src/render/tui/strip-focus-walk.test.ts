/**
 * `stripRows` lists a run once however many lists name it (MVP-11 unit 7, round 2): a recent run a snapshot lists twice is one row. (The
 * one-row-at-a-time walk of `↑`/`↓` is the page-key reducer's and the controller's, pinned in `home-pages.test.ts` and
 * `home-pages-controller.test.ts`; a pure `stepFocus` that once walked it had no production caller and is gone.)
 */
import { describe, expect, it } from 'vitest';

import { runRow, snapshotOf } from './home-controller.test-support.js';
import { stripRows } from './strip-focus.js';

describe('a run is one row however many lists name it', () => {
  it('a recent run listed twice by the snapshot is one row, at its first place', () => {
    const rows = stripRows(
      [],
      snapshotOf({ recentRuns: [runRow('r1'), runRow('r2'), runRow('r1')] }),
    );
    expect(rows.map((entry) => entry.id)).toEqual(['r1', 'r2']);
  });
});
