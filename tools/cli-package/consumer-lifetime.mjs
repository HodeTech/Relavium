import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { abandonFixtures } from '../cli-bootstrap/child.mjs';
import { exitOnInterrupt } from './process.mjs';
import { abandonInstalledSmoke } from './smoke/index.mjs';

/**
 * A success publication includes actual worker settlement and owned installation removal. An
 * interrupt (SIGINT, SIGTERM, SIGHUP) is the primary outcome: it stops every `runCommand` child tree,
 * then the bootstrap witness's bounded children, removes its live fixtures and the installed smoke's
 * worker roots under `supportRoot` (the native fixture targets end with that worker), removes the
 * installation and exits with the signal's code, reporting any failed removal only through
 * `cleanupFailed`. `cleanup` is therefore synchronous.
 * @template T
 * @param {{exercise: () => Promise<T>, cleanup: () => void, cleanupFailed: () => void,
 *   publish: (result: T) => unknown, supportRoot: string}} options
 */
export async function completeConsumer({ exercise, cleanup, cleanupFailed, publish, supportRoot }) {
  assert.ok(
    typeof supportRoot === 'string' && isAbsolute(supportRoot),
    'PACKED_CLI_CONSUMER_SUPPORT_ROOT',
  );
  const secondary = () => {
    try {
      cleanupFailed();
    } catch {
      // A failed secondary diagnostic cannot replace the primary outcome.
    }
  };
  const interrupted = () => {
    let failed = false;
    for (const step of [abandonFixtures, () => abandonInstalledSmoke(supportRoot), cleanup]) {
      try {
        step();
      } catch {
        failed = true;
      }
    }
    if (failed) secondary();
  };
  return exitOnInterrupt(interrupted, async () => {
    let result;
    let primary;
    let primaryFailure = false;
    try {
      result = await exercise();
    } catch (error) {
      primary = error;
      primaryFailure = true;
    }
    try {
      await cleanup();
    } catch (error) {
      if (!primaryFailure) throw error;
      secondary();
    }
    if (primaryFailure) throw primary;
    return publish(result);
  });
}
