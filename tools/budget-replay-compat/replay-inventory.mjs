/** The parent pins the complete acceptance inventory; worker exit alone cannot certify its coverage. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineCommit } from './baseline-provenance.mjs';

const requiredCuts = [
  ['native-pause', 'authority-paused'],
  ['native-pause', 'budget-paused-companion'],
  ['native-pause', 'human-gate-paused-companion'],
  ['native-pause', 'aggregate-paused'],
  ['native-approved', 'authority-decided'],
  ['native-approved', 'human-gate-resumed-companion'],
  ['native-rejected', 'authority-decided'],
  ['native-rejected', 'human-gate-resumed-companion'],
  ['legacy-approved', 'authority-decided'],
  ['legacy-approved', 'human-gate-resumed-companion'],
  ['legacy-rejected', 'authority-decided'],
  ['legacy-rejected', 'human-gate-resumed-companion'],
];
const requiredControls = [
  'actual-legacy-budget-rejection-positive-control',
  'actual-ordinary-legacy-gate-positive-control',
];
const key = ({ label, cut }) => JSON.stringify([label, cut]);
function exactUnique(actual, required, label) {
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate coverage`);
  assert.deepEqual(
    [...actual].sort(),
    [...required].sort(),
    `${label}: incomplete or unexpected coverage`,
  );
}

export function verifyReplayInventory(producer, predecessor) {
  assert.equal(requiredCuts.length, 12, 'pinned prefix coverage');
  assert.equal(requiredControls.length, 2, 'pinned positive coverage');
  assert.equal(predecessor.completed, true, 'predecessor acceptance incomplete');
  assert.equal(predecessor.baselineCommit, baselineCommit, 'predecessor acceptance baseline');
  for (const field of ['fetches', 'providerCalls', 'keyResolutions'])
    assert.equal(producer[field], 0, `producer ${field}`);
  assert.equal(predecessor.fetches, 0, 'predecessor fetches');
  const expected = requiredCuts.map(([label, cut]) => key({ label, cut }));
  exactUnique(producer.cases.map(key), expected, 'producer prefixes');
  exactUnique(
    predecessor.cases.map(({ capture }) => key(capture)),
    expected,
    'predecessor prefixes',
  );
  for (const result of predecessor.cases) {
    assert.deepEqual(
      result.capture,
      producer.cases.find((capture) => key(capture) === key(result.capture)),
      'accepted capture differs from producer',
    );
    for (const field of ['strictError', 'checkpointError', 'engineError'])
      assert.equal(
        result[field]?.code,
        'unreadable_run_event_log',
        `${key(result.capture)}: ${field}`,
      );
    assert.equal(result.rawRowsPreserved, true, 'raw rows not retained');
    assert.equal(result.databaseClosed, true, 'refusal database not closed');
    assert.equal(result.leaseAfterRefusal, null, 'refusal lease not released');
    for (const calls of Object.values(result.callsAtRefusal))
      // Lease acquisition/checkpoint loading are separately allowed and checked below.
      assert.ok(Number.isSafeInteger(calls) && calls >= 0, 'invalid call evidence');
    for (const field of [
      'storeResolve',
      'storeSnapshot',
      'persist',
      'timerArm',
      'abortCreate',
      'execute',
      'providerResolve',
      'keyResolve',
      'providerCall',
      'effectRead',
    ])
      assert.equal(result.callsAtRefusal[field], 0, `refusal ${field}`);
  }
  exactUnique(
    predecessor.controls.map(({ label }) => label),
    requiredControls,
    'positive controls',
  );
  for (const control of predecessor.controls) {
    assert.deepEqual(control.skipped, [], 'positive control skipped rows');
    assert.equal(control.databaseClosed, true, 'positive database not closed');
    assert.equal(control.leaseAfterCompletion, null, 'positive lease not released');
    assert.equal(control.calls.keyResolve, 0, 'positive key resolution');
    assert.equal(control.calls.providerCall, 0, 'positive provider call');
    const terminal = control.events.at(-1);
    if (control.label === requiredControls[0]) {
      assert.equal(terminal?.type, 'run:failed', 'legacy rejection terminal');
      assert.equal(terminal.error.code, 'budget_exceeded', 'legacy rejection diagnosis');
    } else assert.equal(terminal?.type, 'run:completed', 'ordinary approval terminal');
  }
  return { prefixes: requiredCuts, positiveControls: requiredControls, completed: true };
}

/** Negative controls mutate copies of actual completed worker evidence, never the frozen predecessor. */
export function checkReplayInventoryGuards(producer, predecessor, owned) {
  verifyReplayInventory(producer, predecessor);
  const results = [];
  for (const [label, mutate] of [
    ['missing-producer-prefix', (p) => p.cases.pop()],
    ['missing-predecessor-prefix', (_p, r) => r.cases.pop()],
    [
      'duplicate-producer-prefix',
      (p) => {
        p.cases[1] = p.cases[0];
      },
    ],
    [
      'duplicate-predecessor-prefix',
      (_p, r) => {
        r.cases[1] = r.cases[0];
      },
    ],
    [
      'unexpected-prefix',
      (p) => {
        p.cases[0].cut = 'invented-cut';
      },
    ],
    [
      'changed-capture',
      (_p, r) => {
        r.cases[0].capture.sha256 = '0'.repeat(64);
      },
    ],
    ['missing-positive-control', (_p, r) => r.controls.pop()],
    [
      'duplicate-positive-control',
      (_p, r) => {
        r.controls[1] = r.controls[0];
      },
    ],
    [
      'incomplete-predecessor',
      (_p, r) => {
        r.completed = false;
      },
    ],
    [
      'producer-egress',
      (p) => {
        p.providerCalls = 1;
      },
    ],
    [
      'missing-refusal',
      (_p, r) => {
        delete r.cases[0].engineError;
      },
    ],
  ]) {
    const p = globalThis.structuredClone(producer),
      r = globalThis.structuredClone(predecessor);
    mutate(p, r);
    assert.throws(() => verifyReplayInventory(p, r), undefined, label);
    results.push({ label, refused: true });
  }
  results.push({
    label: 'unchanged-complete-worker-evidence',
    ...verifyReplayInventory(producer, predecessor),
  });
  writeFileSync(
    join(owned, 'replay-inventory-guards.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}
