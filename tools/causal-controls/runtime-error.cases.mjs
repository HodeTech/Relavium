/** Actual Vitest runtime-error regression: no user process error listeners. */
import { setImmediate } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import * as fixture from './fixture.mjs';
import { admitted, fixtureProtocol } from './fixture.mjs';

it('CAUSAL_SYNTHETIC_DECLARED', async () => {
  // Give a background rejection/exception its own event-loop delivery before the assertion.
  await setImmediate();
  await setImmediate();
  expect(admitted, 'CAUSAL_SYNTHETIC_DECLARED').toBe(true);
});
it('CAUSAL_SYNTHETIC_POSITIVE', () => {
  expect(fixtureProtocol.version).toBe(1);
  expect(Object.isFrozen(fixtureProtocol)).toBe(true);
});
afterAll(async () => {
  if ('teardownError' in fixture) {
    void Promise.reject(new Error('CAUSAL_BACKGROUND_TEARDOWN'));
    await setImmediate();
    await setImmediate();
  }
});
