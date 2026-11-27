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
import { announcesEffect, modeChangedNotice } from '../chat/mode-effects.js';
import { effortContent, effortInitialRow, effortSpec } from './effort-popup.js';
import { openModels } from './models-session.js';
import {
  MODE_NOT_COMPLETED,
  MODE_STARTUP_KEY,
  modeOfRow,
  modeSpec,
  startupAlreadyAnnouncement,
  startupDefaultAnnouncement,
  type ModeListFacts,
} from './mode-popup.js';
import { openPermissionsPopup } from './permissions-session.js';
import { macrotask, startPopupWork } from './popup-work.js';
import type { PopupContext, PopupOpenResult } from './popup-host.js';
import {
  effortAnnouncement,
  type ModeSettingsPort,
  type SettingsKind,
  type SettingsOpenRequest,
  type SettingsPort,
  type StartupDefaultOutcome,
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
 * What the list is drawn from, read when it opens (never while it is drawn): the mode in force in a chat and the saved startup default. A
 * startup default that could not be read is `undefined`: a chat then marks no row `startup` and offers `[s]` on every row, and the Home does not
 * open (its list IS the startup default).
 */
function modeFacts(member: ModeSettingsPort): ModeListFacts | undefined {
  const startup = member.startup();
  if (member.scope === 'home')
    return startup === undefined ? undefined : { surface: 'home', startup };
  return { surface: 'chat', current: member.current(), startup };
}

/**
 * `Enter` in a chat: the mode is applied to THIS chat at once, through the session's one mode setter (it records the change, refuses a widening
 * whose record could not be written, and says what it did on the host's channel itself); on the mode in force it keeps, changes nothing and
 * says the one line it always said. What the setter does not say (a narrowing, the mode already in force) is said here.
 */
function useInThisChat(
  port: SettingsPort,
  member: Extract<ModeSettingsPort, { readonly scope: 'chat' }>,
  picked: ChatMode,
): void {
  if (member.current() === picked) {
    port.announce(modeChangedNotice(picked), 'mode');
    return;
  }
  if (member.apply(picked) && !announcesEffect(picked))
    port.announce(modeChangedNotice(picked), 'mode');
}

/**
 * `/mode`: ONE list, two actions ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, dated
 * note of 2026-11-27; MVP-11 unit 8, OD-25): a popup never asks for a decision that changes nothing.
 * - a chat: `Enter` applies the highlighted mode to THIS chat at once (or keeps, on the mode in force: nothing changes) and closes; `[s]` saves it
 *   as the startup default (absent on the mode that already is the default);
 * - the bare Home: `Enter` on the saved startup default says so in one notification and closes; on any other mode it saves it as the startup default.
 * Saving is the ONE second screen: the startup-default writer's own flow, framed as `Mode · Confirm · Done` (`mode-confirm.ts`), started on the
 * port's owner once the list has closed. What it came to ({@link StartupDefaultOutcome}) is its Done step, one notification, nothing, or a step
 * back: `Esc` on the confirmation opens the list again on the mode chosen.
 */
function openMode(request: SettingsOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const member = port.mode;
  if (member === undefined) return MISSING;

  /** What a finished hand-off asks of the host: a notification (the flow's, a refusal) or the list again; nothing else. */
  const settle = (outcome: StartupDefaultOutcome, picked: ChatMode): void => {
    if (outcome.kind === 'notice') port.announce(outcome.text);
    else if (outcome.kind === 'back') void present(picked);
  };

  /** The startup-default writer's flow for `picked`, started as work once the key that asked has been handled to its end (its first card is a frame of its own). */
  const handOff = (picked: ChatMode): void => {
    startPopupWork(
      port.workOwner,
      async () => {
        await macrotask();
        settle(await member.saveStartupDefault(picked), picked);
      },
      () => {
        // A fault of the hand-off itself (an owner that no longer admits work: the flow never ran) is the owner's (`startPopupWork` reports it),
        // and nothing was saved: the person is told so rather than left without word.
        port.announce(startupDefaultAnnouncement(picked, { kind: 'refused', autoRevoked: false }));
      },
    );
  };

  /** Open the list, on `initial` where a step back returns to it. */
  const present = (initial?: ChatMode): PopupOpenResult => {
    const facts = modeFacts(member);
    if (facts === undefined) {
      port.announce(MODE_NOT_COMPLETED);
      return MISSING;
    }
    const answered = (context: PopupContext, picked: ChatMode, save: boolean): void => {
      // Closed first: what the setter then says is drawn on the hint row at once, and the writer's first card has the screen to itself.
      context.close();
      if (member.scope === 'chat' && !save) useInThisChat(port, member, picked);
      else if (member.scope === 'home' && facts.startup === picked)
        port.announce(startupAlreadyAnnouncement(picked), 'mode');
      else handOff(picked);
    };
    return host.openForUser(modeSpec(origin, facts, initial), {
      enter: (context, row) => {
        const picked = modeOfRow(row?.id);
        if (picked !== undefined) answered(context, picked, false);
      },
      control: (context, key, row) => {
        const picked = modeOfRow(row?.id);
        if (key === MODE_STARTUP_KEY && picked !== undefined && facts.startup !== picked)
          answered(context, picked, true);
      },
    });
  };
  return present();
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
