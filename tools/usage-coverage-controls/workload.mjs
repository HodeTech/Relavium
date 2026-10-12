import assert from 'node:assert/strict';

export const ordinaryPhaseTimeoutMs = 300_000;
// Pinned complete cohort: 57 CLI crash, four causal crash and ten DB process children.
// Each native case already has a 20s bound; the full DB scale test permits 600s.
export const permanentWorkload = Object.freeze({ cases: 429, nativeChildren: 71 });
export const permanentPhaseTimeoutMs =
  ordinaryPhaseTimeoutMs + permanentWorkload.nativeChildren * 20_000 + 600_000;

export function assertPermanentWorkload(result) {
  assert.equal(result.tests.length, permanentWorkload.cases, 'Permanent case inventory drift');
  assert.equal(
    result.runtime.nativeChildren,
    permanentWorkload.nativeChildren,
    'Permanent native-child inventory drift',
  );
  assert.equal(result.runtime.readinessTimeoutChildren, 1, 'Missing/extra native timeout control');
}

/** Only the declared loaded-but-unready control may finish without a CUT/LOCKED barrier. */
export function assertNativeReadiness(child, events) {
  const records = events.filter((record) => record.pid === child.pid);
  if (child.mode !== 'readiness-timeout-control') {
    assert.ok(
      records.some((record) => record.stage === 'barrier'),
      'Native child did not reach real barrier',
    );
    return;
  }
  assert.deepEqual(
    records.map((record) => record.stage),
    ['spawn', 'not-ready', 'readiness-timeout', 'close'],
    'Native timeout control did not prove its ordered no-barrier lifecycle',
  );
  assert.ok(records.every((record) => record.mode === child.mode));
  assert.ok(records.every((record) => record.callerPid === child.callerPid));
  assert.equal(records[1].kind, 'WAITING');
  assert.equal(records[3].signal, 'SIGKILL');
  assert.equal(records[3].code, null);
}
