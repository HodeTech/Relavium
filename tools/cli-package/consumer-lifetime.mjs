import assert from 'node:assert/strict';
import { exitOnInterrupt } from './process.mjs';

/**
 * A success publication includes actual worker settlement and owned installation removal. An
 * interrupt (SIGINT, SIGTERM, SIGHUP) is the primary outcome: it stops every `runCommand` child tree,
 * runs `abandon` for the children and directories `runCommand` does not own, removes the installation
 * and exits with the signal's code, reporting a failed removal only through `cleanupFailed`. `abandon`
 * and `cleanup` are therefore synchronous.
 * @template T
 * @param {{exercise: () => Promise<T>, cleanup: () => void, cleanupFailed: () => void,
 *   publish: (result: T) => unknown, abandon: () => void}} options
 */
export async function completeConsumer({ exercise, cleanup, cleanupFailed, publish, abandon }) {
  assert.equal(typeof abandon, 'function', 'PACKED_CLI_CONSUMER_ABANDON');
  const secondary = () => {
    try {
      cleanupFailed();
    } catch {
      // A failed secondary diagnostic cannot replace the primary outcome.
    }
  };
  const interrupted = () => {
    try {
      abandon();
      cleanup();
    } catch {
      secondary();
    }
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
