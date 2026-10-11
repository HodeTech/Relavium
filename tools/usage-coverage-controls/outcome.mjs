import assert from 'node:assert/strict';

/** Process closure plus one predeclared semantic case/signature; an arbitrary assertion never certifies a mutant. */
export function checkOutcome(tests, processResult, phase, mechanism, witness) {
  assert.equal(processResult.timedOut, false, 'Control process timed out');
  assert.equal(processResult.joined, true, 'Control process closure was not joined');
  assert.equal(processResult.signal, null, 'Control process was killed');
  assert.equal(processResult.spawnError, undefined, 'Control process failed to spawn');
  assert.ok(['fixed', 'mutated', 'restored'].includes(phase), 'Unknown control phase');
  assert.ok(
    tests.length > 0 && tests.every((test) => test.status === 'passed' || test.status === 'failed'),
    'Incomplete case inventory',
  );
  const failures = tests.filter((test) => test.status === 'failed');
  if (phase !== 'mutated') {
    assert.equal(processResult.code, 0, 'Fixed/restored whole cohort failed');
    assert.equal(failures.length, 0, 'Fixed/restored case failed');
    return;
  }
  assert.equal(processResult.code, 1, 'Mutant was not rejected by complete tests');
  assert.ok(
    witness &&
      typeof witness.file === 'string' &&
      typeof witness.id === 'string' &&
      typeof witness.marker === 'string' &&
      witness.marker.length > 0,
    'Missing predeclared causal witness',
  );
  assert.ok(failures.length > 0, 'Mutant failed before any semantic assertion');
  for (const test of failures) {
    const messages = test.failures.join('\n');
    assert.ok(
      !/USAGE_SOURCE_|USAGE_EVALUATION_|before (?:barrier|readiness)|worker (?:readiness )?deadline|Timed out|Failed to load|Cannot find module|SyntaxError|ReferenceError|TypeError/.test(
        messages,
      ),
      `Setup/runtime failure is not a causal assertion: ${test.id}`,
    );
    // Other whole-cohort failures are retained diagnostics, not substitute causal witnesses.
    assert.ok(
      /AssertionError|expected .* to /s.test(messages) ||
        (mechanism.marker !== undefined && messages.includes(mechanism.marker)) ||
        (/^Error: promise resolved .+ instead of rejecting/m.test(messages) &&
          messages.includes('_Assertion.__VITEST_REJECTS__')),
      `Failure lacks a semantic diagnostic: ${test.id}`,
    );
  }
  assert.ok(
    failures.some(
      (test) =>
        test.file === witness.file &&
        test.id === witness.id &&
        test.failures.some((message) => message.includes(witness.marker)),
    ),
    `Declared semantic witness did not fail: ${mechanism.id}`,
  );
  if (mechanism.positiveFile) {
    const positive = tests.filter((test) => test.file === mechanism.positiveFile);
    assert.ok(
      positive.length > 0 && positive.every((test) => test.status === 'passed'),
      'Outcome-positive receipt controls changed',
    );
  }
}
