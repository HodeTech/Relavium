/**
 * The settings popups' opener ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3,
 * §6): given what the host asked for ({@link SettingsOpenRequest}), it opens the popup the typed line names over the host's popup host. Loaded
 * by a dynamic import the first time a setting is asked for (`openSettings`, `settings-port.ts`), as the reports' is (`report-port.ts`), so no
 * host pays for any of it at start.
 *
 * **One table of openers, typed over every kind of the settings table**, so a setting without an opener does not compile. `/effort` and `/mode` are built
 * here, `/models` in `models-session.ts` and the chat's `/permissions` in `permissions-session.ts` (it withdraws rather than applies: a
 * withdrawal goes back to the lists, refreshed, and is announced on the host's channel).
 *
 * A setting applies and closes, and says what it did on the HOST's channel (`SettingsPort.announce`, which outlives the popup); it writes nothing
 * into the transcript or a Home notice (the residue rule, §6).
 */

import type { ChatMode } from '@relavium/shared';

import { effortRowLabel } from '../chat/effort-notice.js';
import { effortContent, effortInitialRow, effortSpec } from './effort-popup.js';
import { openModels } from './models-session.js';
import { modeOfRow, modeScopeForm, modeSpec, SCOPE_STEP, scopeOf } from './mode-popup.js';
import { openPermissionsPopup } from './permissions-session.js';
import { macrotask, startPopupWork } from './popup-work.js';
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

/**
 * `/mode` in a chat: the four modes, opened on the one in force; `Enter` on one goes to the step that names it, states its effect where it
 * approves something without a card, and asks where it applies. `Enter` there closes the popup and applies, whichever way it went:
 * - this chat: through the session's one mode setter, which records the change, refuses a widening whose record could not be written, and
 *   says what it did on the host's channel itself; the popup adds no word, and is done whatever the setter answered;
 * - new chats: the startup-default writer's own flow on this chat's native prompt (its confirmation, its disclosure, its publication, its
 *   result), started on the session's work owner once the popup has gone; this chat's mode does not change.
 *
 * `Esc` steps back from the second step and closes from the first, changing nothing.
 */
function openMode(request: SettingsOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const mode = port.mode;
  if (mode === undefined) return MISSING;
  // The mode the first step answered with: what the second names and applies (set again each time the first answers).
  let chosen: ChatMode | undefined;
  return host.openForUser(modeSpec(origin, mode.current()), {
    enter: (context, row) => {
      const picked = modeOfRow(row?.id);
      if (picked === undefined) return;
      chosen = picked;
      if (context.setContent(SCOPE_STEP, modeScopeForm(picked))) context.goToStep(SCOPE_STEP);
    },
    apply: (context, values) => {
      const picked = chosen;
      const scope = scopeOf(values.radio);
      if (picked === undefined || scope === undefined) return;
      // Closed first: what the setter then says is drawn on the hint row at once, and the startup flow's first card has the screen to itself.
      context.close();
      if (scope === 'this-chat') {
        mode.apply(picked);
        return;
      }
      startPopupWork(
        port.workOwner,
        async () => {
          // Once the key that applied has been handled to its end: the flow's first card is a frame of its own, which no key has reached.
          await macrotask();
          await mode.saveStartupDefault(picked);
        },
        () => {
          // The popup is gone and the flow has said its own words: a fault of the hand-off is the work owner's (`startPopupWork` reports it).
        },
      );
    },
  });
}

/** What opens each setting: the one table of this file, typed over every kind of the settings table, so a kind without an opener does not compile. */
const OPENERS: Readonly<Record<SettingsKind, (request: SettingsOpenRequest) => PopupOpenResult>> = {
  mode: openMode,
  effort: openEffort,
  models: openModels,
  permissions: openPermissionsPopup,
};

/** Open the settings popup `request.command` names; see the module header. A refused open is said by the host in one notification. */
export function openSettingsPopup(request: SettingsOpenRequest): PopupOpenResult {
  return OPENERS[request.command](request);
}
