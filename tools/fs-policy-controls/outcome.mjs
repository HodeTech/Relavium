import assert from 'node:assert/strict';
import { relative } from 'node:path';
/** Reject infrastructure failures and incomplete inventories before considering semantic witnesses. */
export function assertPhaseOutcome(data, child, control, name, graph) {
  assert.equal(child.spawnError, undefined, 'Runner spawn failure');
  assert.equal(child.signal, null, 'Runner signaled');
  assert.equal(child.timedOut, false, 'Runner timed out');
  assert.equal(child.outputExceeded, false, 'Runner output overflow');
  assert.equal(child.joined, true, 'Runner not joined');
  assert.ok(
    !/Unhandled Errors|Unhandled Error|Unhandled Rejection/i.test(child.stderr),
    'Unhandled runtime error',
  );
  assert.ok(
    data.testResults.every((file) => file.message === ''),
    'Setup or collection error',
  );
  const tests = data.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({
      file: relative(graph, file.name),
      id: test.fullName,
      status: test.status,
      failures: test.failureMessages,
    })),
  );
  assert.equal(tests.length, control.expectedTests, 'Declared workload drift');
  assert.equal(tests.length, data.numTotalTests);
  assert.equal(data.numPendingTests, 0);
  assert.equal(data.numTodoTests, 0);
  assert.deepEqual([...new Set(tests.map((t) => t.file))].sort(), [...control.files].sort());
  assert.equal(new Set(tests.map((t) => t.file + ':' + t.id)).size, tests.length);
  assert.ok(
    tests.every((t) => t.status === 'passed' || t.status === 'failed'),
    'Incomplete case',
  );
  const failed = tests.filter((t) => t.status === 'failed');
  assert.equal(data.numFailedTests, failed.length);
  assert.equal(data.numPassedTests, tests.length - failed.length);
  assert.ok(
    failed.every(
      (t) =>
        t.failures.length > 0 &&
        t.failures.every(
          (message) =>
            !/Failed to load|Cannot find|SyntaxError|ReferenceError|timed out|beforeEach hook|afterEach hook|USAGE_SOURCE_/i.test(
              message,
            ),
        ),
    ),
    'Infrastructure/setup/timeout cannot certify removal',
  );
  if (name === 'mutated') {
    assert.equal(child.code, 1, `${control.id}: removal survived`);
    assert.ok(
      failed.some(
        (t) => t.id.includes(control.target) && t.failures.some((m) => m.includes(control.marker)),
      ),
      `${control.id}: missing declared named assertion ${control.marker}`,
    );
    if (control.id.startsWith('ancestor-'))
      for (const port of ['tool', 'save_to'])
        assert.ok(
          failed.some(
            (t) =>
              t.id.includes(control.target + ' ' + port) &&
              t.failures.some((m) => m.includes(control.marker)),
          ),
          'Shared helper must fail through both actual consumers',
        );
  } else {
    assert.equal(child.code, 0, `${control.id}/${name}: baseline/restoration failed`);
    assert.equal(failed.length, 0);
    assert.equal(data.numPassedTests, tests.length);
  }
  return { tests, failed };
}
