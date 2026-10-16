import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRuntimeStderr } from './runtime-stderr.mjs';

const warning =
  '(node:123) ExperimentalWarning: Importing JSON modules is an experimental feature and might change at any time\n' +
  '(Use `node --trace-warnings ...` to show where the warning was created)\n';
const identity = { runtime: 'v22.0.0', pid: 123 };
const diagnostic = '{"code":"cli_internal","message":"A background operation failed."}\n';

test('only the exact owned minimum-runtime warning is separate from product diagnostics', () => {
  for (const text of [warning, warning + diagnostic, diagnostic + warning]) {
    const projected = projectRuntimeStderr(text, identity);
    assert.equal(projected.diagnostics, text.replace(warning, ''));
    assert.deepEqual(projected.runtimeWarnings, ['node-22.0.0-experimental-json-modules']);
  }
});

test('runtime identity, PID, frame boundaries and one-warning limit remain mandatory', () => {
  for (const [text, owner] of [
    [warning, { ...identity, runtime: 'v22.23.1' }],
    [warning, { ...identity, pid: 124 }],
    [warning, { ...identity, pid: -1 }],
    [warning + warning, identity],
    ['prefix' + warning, identity],
    [warning.replace('experimental feature', 'different warning'), identity],
    [warning.replace('node --trace-warnings', 'other --trace-warnings'), identity],
    [warning.slice(0, -1), identity],
    ['Unhandled rejection\n' + diagnostic, identity],
  ]) {
    assert.deepEqual(projectRuntimeStderr(text, owner), {
      diagnostics: text,
      runtimeWarnings: [],
    });
  }
});

test('unknown runtime output survives alongside the one recognized warning', () => {
  const foreign = 'Error: unrelated runtime failure\n';
  const projected = projectRuntimeStderr(warning + foreign + diagnostic, identity);
  assert.equal(projected.diagnostics, foreign + diagnostic);
  assert.throws(() => JSON.parse(projected.diagnostics));
});
