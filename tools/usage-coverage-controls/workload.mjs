import assert from 'node:assert/strict';

export const ordinaryPhaseTimeoutMs = 300_000;
// Pinned complete cohort: 57 CLI crash, four causal crash and eight DB process children.
// Each native case already has a 20s bound; the full DB scale test permits 600s.
export const permanentWorkload = Object.freeze({ cases: 427, nativeChildren: 69 });
export const permanentPhaseTimeoutMs =
  ordinaryPhaseTimeoutMs + permanentWorkload.nativeChildren * 20_000 + 600_000;

export function assertPermanentWorkload(result) {
  assert.equal(result.tests.length, permanentWorkload.cases, 'Permanent case inventory drift');
  assert.equal(
    result.runtime.nativeChildren,
    permanentWorkload.nativeChildren,
    'Permanent native-child inventory drift',
  );
}
