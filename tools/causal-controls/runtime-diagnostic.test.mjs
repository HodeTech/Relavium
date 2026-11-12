import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeDiagnostic } from './runtime-diagnostic.mjs';

const identity = { phase: 'mutated', mutationId: 'invocation-forward' };
const root = '/private/probe/graph';
const files = [{ path: 'apps/cli/src/run.ts' }];

test('reports only allowlisted error kind and an owned source frame', () => {
  const result = runtimeDiagnostic(
    [
      {
        name: 'TypeError',
        type: 'Unhandled Rejection',
        message: 'provider-secret',
        stack: `TypeError: provider-secret\n    at hidden (/private/home/private.ts:4:8)\n    at run (${root}/apps/cli/src/run.ts:87:12)`,
      },
    ],
    identity,
    root,
    files,
  );
  assert.deepEqual(result, {
    version: 1,
    diagnostic: 'unhandled-runtime-errors',
    ...identity,
    count: 1,
    truncated: false,
    entries: [
      {
        kind: 'TypeError',
        origin: 'Unhandled Rejection',
        reportedFrame: { path: 'apps/cli/src/run.ts', line: 87 },
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /provider-secret|private\/home|private\/probe/);
});

test('does not invoke getters, stringify values or traverse cycles and hostile proxies', () => {
  let touched = false;
  const error = {
    get name() {
      touched = true;
      throw Error('secret');
    },
    get type() {
      touched = true;
      throw Error('secret');
    },
    get stack() {
      touched = true;
      throw Error('secret');
    },
    cause: null,
  };
  error.cause = error;
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error('secret');
      },
    },
  );
  const result = runtimeDiagnostic([error, proxy], identity, root, files);
  assert.equal(touched, false);
  assert.deepEqual(
    result.entries,
    Array(2).fill({ kind: 'unknown', origin: 'unknown', reportedFrame: null }),
  );
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('bounds and rejects fake frames and untrusted fields', () => {
  const inputs = Array.from({ length: 12 }, () => ({
    name: 'provider-secret',
    type: 'provider-secret',
    stack: `secret\n    at ${root}/apps/cli/src/other.ts:2:3\n    at ${root}/apps/cli/src/run.ts:0:5`,
  }));
  const result = runtimeDiagnostic(inputs, identity, root, files);
  assert.equal(result.count, 12);
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 8);
  assert.ok(
    result.entries.every(
      (entry) =>
        entry.kind === 'unknown' && entry.origin === 'unknown' && entry.reportedFrame === null,
    ),
  );
  assert.doesNotMatch(JSON.stringify(result), /secret|other\.ts/);
  assert.equal(
    runtimeDiagnostic([{ stack: 'x'.repeat(32769) }], identity, root, files).entries[0]
      .reportedFrame,
    null,
  );
  assert.equal(runtimeDiagnostic([], identity, root, files), null);
  assert.equal(
    runtimeDiagnostic(inputs, { ...identity, mutationId: 'secret/path' }, root, files),
    null,
  );
});

test('array accessors are ignored', () => {
  let touched = false;
  const errors = [];
  Object.defineProperty(errors, '0', {
    get() {
      touched = true;
      throw Error('secret');
    },
  });
  const result = runtimeDiagnostic(errors, identity, root, files);
  assert.equal(touched, false);
  assert.equal(result.entries[0].kind, 'unknown');
});
