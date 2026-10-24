/**
 * Test-only: a spawned tool's exit within a bound, so that a regressed tool fails its test instead of
 * hanging it, which would let the runner kill the test and leave the tool's detached descendants
 * behind. Call it before signalling the child.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [timeoutMs]
 * @returns {Promise<[number | null, string | null]>} the exit code and signal
 */
export function exitWithin(child, timeoutMs = 30_000) {
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve([code, signal])),
  );
  // Unreferenced, so a pending bound never keeps the test process alive after the child exits.
  const bound = delay(timeoutMs, undefined, { ref: false });
  return Promise.race([exit, bound]).then((outcome) => {
    assert.ok(outcome !== undefined, `the child did not exit within ${timeoutMs} ms`);
    return outcome;
  });
}
