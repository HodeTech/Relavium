/** Selected only by the coordinator integration guard, never by ordinary workspace tests. */
import { expect, it } from 'vitest';
import { admitted, fixtureProtocol } from './fixture.mjs';
it('CAUSAL_SYNTHETIC_DECLARED', () => {
  expect(admitted, 'CAUSAL_SYNTHETIC_DECLARED').toBe(true);
});
it('CAUSAL_SYNTHETIC_POSITIVE', () => {
  expect(typeof admitted).toBe('boolean');
  expect(fixtureProtocol.version).toBe(1);
  expect(Object.isFrozen(fixtureProtocol)).toBe(true);
});
