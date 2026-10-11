/** Capture actual current durable arguments before any basis-count acceptance assertion. */
import assert from 'node:assert/strict';
import { captureUsagePrefix } from './usage-producer.mjs';
import { record } from './producer-common.mjs';
let fetches = 0;
globalThis.fetch = () => {
  fetches += 1;
  throw new Error('Network forbidden');
};
const captured = await captureUsagePrefix(true);
assert.equal(captured.localFixtureCalls, 0);
assert.equal(captured.cases.length, 1);
assert.equal(fetches, 0);
record('results/ordinary-gate-producer.json', {
  completed: true,
  cases: captured.cases,
  localFixtureCalls: 0,
  fetches,
  eventTypes: captured.events.map((event) => event.type),
  basisCount: captured.events.filter((event) => event.type === 'cost:coverage_started').length,
  capturePrecedesBasisAssertion: true,
});
