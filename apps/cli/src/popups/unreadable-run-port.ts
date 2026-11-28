/**
 * What a host hands the card of an unreadable run, and the one way it opens it ([MVP-11](../../../../docs/roadmap/phases/mvp-11.md) unit 7;
 * [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §10). This module is the EAGER half,
 * split from the lazy one as `report-port.ts` is: the request, and a loader that brings the card's code (`unreadable-run-card.ts`) in only when the
 * person first presses `Enter` on such a row, so the Home's first paint never pays for it (`lazy-load.test.ts`).
 *
 * The Home controller recognises the row and calls its `openUnreadableRun` with the run it found BY ITS ID in the snapshot it holds; the host
 * (`driveHome`) calls {@link openUnreadableRun} on its popup host. A data module ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10).
 */

import type { HomeUnreadableRun } from '../home/home-store.js';
import type { ClipboardWriter } from '../render/clipboard.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupHost } from './popup-host.js';

/** What a host asks for when it opens the card of an unreadable run. */
export interface UnreadableRunOpenRequest {
  readonly host: PopupHost;
  /** The run as the Home's snapshot holds it: what the card says, and the only source of it. */
  readonly run: HomeUnreadableRun;
  readonly origin: PopupOrigin;
  /** The clock (epoch ms) the run's age is measured against. */
  readonly now: () => number;
  /** The host's one clipboard closure (OSC 52) that `[c] copy` writes through; absent, copying says it is not available here. */
  readonly clipboard?: ClipboardWriter | undefined;
  /** The copied card is written in the glyphs' plain forms (colour is off, ADR-0145 §5). */
  readonly plainGlyphs?: boolean | undefined;
}

/**
 * The hosts whose card is being loaded now. The first open of a process waits for the card's code, and a key held down repeats into that wait:
 * each repeat is `Enter` on the same row again, and a second open would find the first one open and raise "another popup is open" inside it.
 */
const loading = new WeakSet<PopupHost>();

/**
 * Open the card over `request.host`, loading its code on first use. The promise settles once the popup is open or refused (the host's gate says
 * why in one notification); it rejects only when the code could not be loaded, which the caller reports as a fault of its own. A call while an
 * earlier one for the same host is still loading is dropped: it is the repeat of the same press.
 */
export async function openUnreadableRun(request: UnreadableRunOpenRequest): Promise<void> {
  if (loading.has(request.host)) return;
  loading.add(request.host);
  try {
    const { openUnreadableRunCard } = await import('./unreadable-run-card.js');
    openUnreadableRunCard(request);
  } finally {
    loading.delete(request.host);
  }
}
