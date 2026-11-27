/**
 * The Home's management popups' opener ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10 as
 * amended 2026-11-27; [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4): given what the host asked for
 * ({@link HomePopupOpenRequest}), it opens the popup the kind names over the host's popup host. Loaded by a dynamic import the first time one is asked
 * for (`openHomePopup`, `home-port.ts`), as the reports' is (`report-port.ts`), so no host pays for any of it at start.
 *
 * **One table of openers, typed over every kind**, so a kind without an opener does not compile. `/help` is built from what the Home already holds and
 * opened with its content (no read, nothing to wait for), with `[c] copy` like every report; `/agents` and `/workflows` read in work they start. All
 * three write nothing into a transcript or the Home's notice (the residue rule, ADR-0148 §6).
 */

import { homeHelpContent, homeHelpSpec } from './home-help-popup.js';
import { openHomeAgents } from './home-agents-session.js';
import type { HomePopupKind, HomePopupOpenRequest } from './home-port.js';
import { openHomeWorkflows } from './home-workflows-session.js';
import { copyReport } from './popup-copy.js';
import type { PopupOpenResult } from './popup-host.js';

/** Why a popup the host asked for could not open at all: the port lacks what it needs (a host's wiring mistake, never reachable from a typed word). */
const MISSING: PopupOpenResult = { opened: false, reason: 'closed' };

function openHelp(request: HomePopupOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const help = port.help;
  if (help === undefined) return MISSING;
  const content = homeHelpContent(help.keys);
  return host.openForUser(homeHelpSpec(origin, content), {
    control: (context, key) => {
      if (key === 'c' && content.kind === 'report')
        copyReport(context, port, 'Help', content.lines);
    },
  });
}

/** What opens each popup: the one table of this file. */
const OPENERS: Readonly<Record<HomePopupKind, (request: HomePopupOpenRequest) => PopupOpenResult>> =
  {
    help: openHelp,
    agents: openHomeAgents,
    workflows: openHomeWorkflows,
  };

/** Open the Home popup `request.kind` names; see the module header. A refused open is said by the host in one notification. */
export function openHomePopupNow(request: HomePopupOpenRequest): PopupOpenResult {
  return OPENERS[request.kind](request);
}
