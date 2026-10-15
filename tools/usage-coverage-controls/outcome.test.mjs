import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOutcome } from './outcome.mjs';

const witness = {
  file: 'owned.test.ts',
  id: 'declared semantic case',
  marker: 'USAGE_CAUSAL_DECLARED',
};
const mechanism = { id: 'declared-mechanism', positiveFile: 'positive.test.ts' };
const processResult = { code: 1, signal: null, timedOut: false, joined: true };
const failure = {
  file: witness.file,
  id: witness.id,
  status: 'failed',
  failures: [`AssertionError: ${witness.marker}: expected false to be true`],
};
const positive = { file: 'positive.test.ts', id: 'positive', status: 'passed', failures: [] };
const check = (cases, result = processResult) =>
  checkOutcome(cases, result, 'mutated', mechanism, witness);

test('certifies the named semantic assertion while preserving additional whole-cohort diagnostics', () => {
  assert.doesNotThrow(() =>
    check([
      failure,
      positive,
      { ...failure, id: 'another', failures: ['AssertionError: expected 0 to be 1'] },
    ]),
  );
});
for (const [name, patch] of Object.entries({
  unrelatedAssertion: { id: 'unrelated case', failures: ['AssertionError: expected 0 to be 1'] },
  wrongCaseWithMarker: { id: 'another case' },
  wrongFileWithMarker: { file: 'foreign.test.ts' },
  rightCaseWrongMarker: { failures: ['AssertionError: expected false to be true'] },
  genericMarkerWithoutAssertion: { failures: [witness.marker] },
  runtimeError: { failures: [`TypeError: ${witness.marker}`] },
  setupError: { failures: [`AssertionError: ${witness.marker}; Cannot find module`] },
  timeoutError: { failures: [`AssertionError: ${witness.marker}; Timed out`] },
}))
  test(`refuses ${name}`, () => assert.throws(() => check([{ ...failure, ...patch }, positive])));
for (const [name, patch] of Object.entries({
  successfulExit: { code: 0 },
  unsignedFailure: { code: 2 },
  killed: { signal: 'SIGTERM' },
  timeout: { timedOut: true },
  unjoined: { joined: false },
  spawn: { spawnError: 'not spawned' },
}))
  test(`refuses ${name}`, () =>
    assert.throws(() => check([failure, positive], { ...processResult, ...patch })));
test('refuses no cases, missing positive, failed positive and absent declaration', () => {
  assert.throws(() => check([]));
  assert.throws(() => check([failure]));
  assert.throws(() =>
    check([failure, { ...positive, status: 'failed', failures: failure.failures }]),
  );
  assert.throws(() => checkOutcome([failure, positive], processResult, 'mutated', mechanism));
});
test('fixed and restored require a successful complete cohort', () => {
  for (const phase of ['fixed', 'restored']) {
    assert.doesNotThrow(() =>
      checkOutcome([positive], { ...processResult, code: 0 }, phase, mechanism, witness),
    );
    assert.throws(() =>
      checkOutcome([failure, positive], { ...processResult, code: 0 }, phase, mechanism, witness),
    );
    assert.throws(() => checkOutcome([positive], processResult, phase, mechanism, witness));
  }
});

for (const phase of ['fixed', 'mutated', 'restored']) {
  test(`${phase} refuses duplicate identities while allowing equal names in different files`, () => {
    const result = { ...processResult, code: phase === 'mutated' ? 1 : 0 };
    const cases = phase === 'mutated' ? [failure, positive] : [positive];
    assert.throws(
      () => checkOutcome([...cases, { ...positive }], result, phase, mechanism, witness),
      /Duplicate case identity/,
    );
    assert.doesNotThrow(() =>
      checkOutcome(
        [...cases, { ...positive, file: 'other.test.ts' }],
        result,
        phase,
        mechanism,
        witness,
      ),
    );
  });
}

test('refuses empty, skipped and unfinished inventories in every phase', () => {
  for (const phase of ['fixed', 'mutated', 'restored'])
    for (const cases of [
      [],
      [{ ...positive, status: 'pending' }],
      [{ ...positive, status: 'todo' }],
    ]) {
      assert.throws(() =>
        checkOutcome(
          cases,
          { ...processResult, code: phase === 'mutated' ? 1 : 0 },
          phase,
          mechanism,
          witness,
        ),
      );
    }
  assert.throws(() =>
    checkOutcome([positive], { ...processResult, code: 0 }, 'typo', mechanism, witness),
  );
});
