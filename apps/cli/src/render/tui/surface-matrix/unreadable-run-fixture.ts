import type { HomeSnapshot, HomeUnreadableRun } from '../../../home/home-store.js';
import { POPULATED_SNAPSHOT } from './home-fixtures.js';
import { MATRIX_NOW_MS } from './home-host.js';
import { popupBoxOf, recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';

/**
 * The card of an unreadable run in the surface matrix (MVP-11 unit 7; [ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §10), opened the way a person opens it: `↓` from the landing onto the work page, which lands on its first Attention row (the one run whose log
 * cannot be read), then `Enter`. The popup is over the work page with that row focused; its box is the frame the host has open, through the one
 * geometry function and the frame model, like every popup's.
 */

/** A run the summary read could name in full, whose log has a row a newer version wrote: the longest of the card's three texts. */
export const UNREADABLE_FIXTURE: HomeUnreadableRun = {
  runId: '3f9a1c2e-5b7d-4e11-9a0c-77d2e3f4a5b6',
  workflowSlug: 'release-notes',
  status: 'failed',
  createdAt: new Date(MATRIX_NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
  reason: 'newer-version',
};

/** The populated Home with the unreadable run as its one Attention row: the work page's first row, so one `↓` focuses it. */
const SNAPSHOT: HomeSnapshot = {
  ...POPULATED_SNAPSHOT,
  failedRuns: [],
  unreadableRuns: [UNREADABLE_FIXTURE],
  totals: { ...POPULATED_SNAPSHOT.totals, attention: 1 },
};

/** The words only the card has: the closing line of every reason's text. */
export const UNREADABLE_LANDMARK = 'Nothing was changed or started.';

/** The legend row of the card: the copy, and the way out. */
export const UNREADABLE_LEGEND_ROW = '[c] copy · Esc close';

/** The box of the card the host has open in this cell. */
export const unreadableRunBox = (variant: Variant, live?: PopupFrame, locked = false): PopupBox =>
  popupBoxOf(live, variant, undefined, locked);

export const UNREADABLE_RUN_SURFACES: readonly HomeSurface[] = [
  {
    host: 'home',
    id: 'home.unreadable-run-card',
    title: 'The card of an unreadable run (Enter on its row of the work page)',
    exitKey: 'Esc',
    landmark: UNREADABLE_LANDMARK,
    legendRow: UNREADABLE_LEGEND_ROW,
    belowFloor: /too small for this popup/iu,
    popup: unreadableRunBox,
    backdropHasNoInverse:
      'a focused Attention row is › + bold + its tint with no inverse (MVP-11 unit 7), and no prompt cursor is drawn while a row is focused',
    setup: () => ({ snapshot: SNAPSHOT }),
    notes:
      'the body behind the popup: the work page with the unreadable run’s row focused (a popup cannot open over a tab screen); the card is opened by Enter on that row',
    open: async (m) => {
      // The card's code is loaded on the first `Enter` (`unreadable-run-port.ts`): a cold dynamic import can outlast the wait for its frame when the
      // whole suite loads the machine, and the cell would then find no popup. A cell measures the card, not the first load of its code, so it is
      // loaded here, as it already is in every later cell of a real session (the Home's management popups warm theirs the same way).
      await import('../../../popups/unreadable-run-card.js');
      // The controller's own keys, as the bare Home's `/models` and `/doctor` surfaces drive theirs: below the floor the host delivers only the
      // way out, and the popup host's own notice is what the cell is checked on.
      await m.until(() => m.homePainted());
      m.controller.handleKey('', { downArrow: true });
      await m.until(() => m.controller.getSnapshot().stripFocus !== undefined && m.homePainted());
      recordBaseline(m);
      m.controller.handleKey('', { return: true });
      await m.settle();
      await m.until(() => m.popupFrame() !== undefined);
      await m.settle();
    },
  },
];
