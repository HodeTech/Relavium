/**
 * `/mode` on the bare Home: the Home's entry into THE ONE persistent-write confirmation ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6, with its dated note of 2026-11-27; [MVP-11 unit 8 §6](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md), OD-25).
 *
 * The bare Home has no conversation, so its `/mode` is a PERSISTENT write of the global startup default only. Its list is the popup host's
 * (`mode-popup.ts`, surface `home`: the saved default marked `startup`, `Enter` on it says "Startup default is already <mode>" and closes, `Enter`
 * on any other mode hands off here); what follows is the shared flow (`mode-confirm.ts`): `Mode · Confirm · Done`, the startup-default writer's own
 * flow unchanged (`runStartupDefaultSave`), its confirmation the chord card (`Ctrl+Y`, default No, a lockout from the card's appearance), its Done
 * step persistent and naming the file. This module adds only what is the Home's: its origin on the top edge and no "this chat stays" line (there
 * is no chat). The chat's `[s]` runs the same flow with its own origin and that line.
 */

import type { ChatMode } from '@relavium/shared';

import { runStartupDefaultFlow, type StartupDefaultFlowDeps } from './mode-confirm.js';
import type { StartupDefaultOutcome } from './settings-port.js';

/** What the Home hands the flow: everything of {@link StartupDefaultFlowDeps} but what is the Home's own (its origin, and no chat's mode). */
export type HomeStartupDefaultDeps = Omit<StartupDefaultFlowDeps, 'origin' | 'inChat'>;

/**
 * Save `mode` as the startup default from the bare Home: the shared confirmation, framed as `from Home`. Resolves with what it came to (see
 * `StartupDefaultOutcome`); never rejects.
 */
export function saveHomeStartupDefault(
  deps: HomeStartupDefaultDeps,
  mode: ChatMode,
): Promise<StartupDefaultOutcome> {
  return runStartupDefaultFlow({ ...deps, origin: 'home', inChat: undefined }, mode);
}
