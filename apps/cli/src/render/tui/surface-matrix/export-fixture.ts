import type { ReportsPort, ReportSurface } from '../../../popups/report-port.js';
import type { SessionViewSeed } from '../session-view-model.js';
import { recordBaseline } from './popup-fixture.js';
import { reportPopupBox } from './report-fixture.js';
import type { ChatSurfaceDefinition } from './surfaces-chat.js';

/**
 * The in-chat `/export` confirmation (MVP-11 unit 6, 6.3; ADR-0148 §10, OD-10) as a surface of both chats: the file it would write, that it is
 * a new one, and the review sentence, on a line `Ctrl+Y` answers. Its port is a fake that writes nothing (a fresh one per cell); the popup is
 * opened by typing `/export`, through the chat host's routing, and checked as every popup is.
 */

export const EXPORT_LANDMARK = 'A new file in the project.';
/** The confirmation's legend row: its one answer and its way back. */
export const EXPORT_LEGEND_ROW = '[Ctrl+Y] export · Esc cancel';

/** A reports port that holds only `/export`, over a fake that writes nothing. */
export function exportReportsPort(surface: ReportSurface): ReportsPort {
  return {
    surface,
    export: {
      prepare: () => ({
        target: '.relavium/workflows/fix-the-flaky-test.relavium.yaml',
        overwrites: false,
      }),
      commit: () => ({ target: '.relavium/workflows/fix-the-flaky-test.relavium.yaml' }),
      failure: () => 'The export failed.',
      review:
        'Exported workflow is a scaffold; conversation context is not reproduced. Review it before committing.',
    },
  };
}

/** The confirmation over `seed` (the chat behind the popup), in both hosts. */
export function chatExportSurface(seed: SessionViewSeed): ChatSurfaceDefinition {
  return {
    name: 'export-confirm',
    title:
      'The /export confirmation popup over the chat: the file it writes, and the review sentence',
    exitKey: 'Esc',
    landmark: EXPORT_LANDMARK,
    legendRow: EXPORT_LEGEND_ROW,
    belowFloor: /too small for this popup/iu,
    popup: reportPopupBox,
    setup: () => ({ seed, reports: exportReportsPort('standalone-chat') }),
    notes:
      'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the popup is opened by typing /export, through the chat host’s routing',
    open: async (m) => {
      recordBaseline(m);
      await m.typeLine('/export');
      await m.until(() => m.text().includes(EXPORT_LANDMARK));
      await m.settle();
    },
  };
}
