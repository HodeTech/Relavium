import type { ChatMode } from '@relavium/shared';

import { startingModePreference, type StartingModeRuntime } from './starting-mode.js';

/**
 * The saved startup default (the global `default_mode`) as the `/mode` popup's list marks it `startup` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, MVP-11 unit 8, OD-25), or `undefined` where the configuration could not be read.
 *
 * It is read through the invocation's own runtime (`runtime.read`), as the startup-default writer's flow reads it and as the doctor does, so a
 * live change of the configuration is OBSERVED by the same authority: a configuration that cannot be read, or one that no longer says `auto`,
 * revokes startup `auto` for this invocation (a narrowing only; it never widens anything). Never throws: the popup says what it can.
 */
export function readStartupDefault(
  runtime: Pick<StartingModeRuntime, 'read'>,
  cwd: string,
): ChatMode | undefined {
  try {
    return startingModePreference(runtime.read(cwd)).globalMode;
  } catch {
    return undefined;
  }
}
