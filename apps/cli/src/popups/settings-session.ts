/**
 * The settings popups' opener ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3,
 * §6): given what the host asked for ({@link SettingsOpenRequest}), it opens the popup the typed line names over the host's popup host. Loaded
 * by a dynamic import the first time a setting is asked for (`openSettings`, `settings-port.ts`), as the reports' is (`report-port.ts`), so no
 * host pays for any of it at start.
 *
 * **One table of openers, typed over every kind of the settings table**, so a setting without an opener does not compile. `/effort` is built here;
 * `/mode`, `/models` and the chat's `/permissions` are later increments of MVP-11 step 5, and until each lands its row opens nothing (its port
 * member is absent by type, so the routing never sends its line here: the line goes on to what opens it today).
 *
 * A setting applies and closes, and says what it did on the HOST's channel (`SettingsPort.announce`, which outlives the popup); it writes nothing
 * into the transcript or a Home notice (the residue rule, §6).
 */

import { effortRowLabel } from '../chat/effort-notice.js';
import { effortContent, effortInitialRow, effortSpec } from './effort-popup.js';
import type { PopupOpenResult } from './popup-host.js';
import {
  effortAnnouncement,
  type SettingsKind,
  type SettingsOpenRequest,
} from './settings-port.js';

/** Why a setting the host asked for could not open at all: the port lacks what it needs (a host's wiring mistake, never reachable from a typed line). */
const MISSING: PopupOpenResult = { opened: false, reason: 'closed' };

/**
 * `/effort`: the tiers this model takes, opened on the tier in force. `Enter` on a tier applies it to the session (unless it is the tier in force
 * already), closes the popup and announces it; `Esc` closes and changes nothing.
 */
function openEffort(request: SettingsOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const effort = port.effort;
  if (effort === undefined) return MISSING;
  const model = effort.model();
  const tiers = effort.tiers();
  const current = effort.current();
  return host.openForUser(
    effortSpec(
      origin,
      effortContent(model, tiers, current),
      effortInitialRow(model, tiers, current),
    ),
    {
      enter: (context, row) => {
        const tier = tiers.find((candidate) => candidate === row?.id);
        if (tier === undefined) return;
        // Compared with the tier in force NOW, as the overlay compared it: the same tier is no change and is said so.
        const already = tier === effort.current();
        if (!already) effort.apply(tier);
        // Closed first, so the notification is drawn on the hint row at once rather than in the legend row of a popup that is going.
        context.close();
        port.announce(effortAnnouncement(effortRowLabel(model, tier).label, already));
      },
    },
  );
}

/** A setting whose popup is a later increment: its port member is absent by type, so this is never reached from a typed line. */
const pending = (): PopupOpenResult => MISSING;

/** What opens each setting: the one table of this file, typed over every kind of the settings table, so a kind without an opener does not compile. */
const OPENERS: Readonly<Record<SettingsKind, (request: SettingsOpenRequest) => PopupOpenResult>> = {
  mode: pending,
  effort: openEffort,
  models: pending,
  permissions: pending,
};

/** Open the settings popup `request.command` names; see the module header. A refused open is said by the host in one notification. */
export function openSettingsPopup(request: SettingsOpenRequest): PopupOpenResult {
  return OPENERS[request.command](request);
}
