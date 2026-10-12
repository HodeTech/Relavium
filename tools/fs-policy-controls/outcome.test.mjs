import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPhaseOutcome } from './outcome.mjs';
const mechanism = {
  id: 'boundary',
  target: 'named regression',
  marker: 'FS_CAUSAL_BOUNDARY',
  files: ['suite.mjs'],
  expectedTests: 1,
};
function sample() {
  return {
    child: {
      code: 1,
      signal: null,
      spawnError: undefined,
      timedOut: false,
      outputExceeded: false,
      joined: true,
      stderr: '',
    },
    data: {
      numTotalTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTests: 1,
      numPassedTests: 0,
      testResults: [
        {
          name: '/graph/suite.mjs',
          message: '',
          assertionResults: [
            {
              fullName: 'named regression',
              status: 'failed',
              failureMessages: ['AssertionError: FS_CAUSAL_BOUNDARY expected refusal'],
            },
          ],
        },
      ],
    },
  };
}
test('complete named assertion failure certifies its specific removal', () => {
  const { data, child } = sample();
  assert.doesNotThrow(() => assertPhaseOutcome(data, child, mechanism, 'mutated', '/graph'));
});
for (const [name, change] of [
  [
    'nonzero without named assertion',
    ({ data }) => {
      data.testResults[0].assertionResults[0].failureMessages = ['AssertionError: unrelated'];
    },
  ],
  [
    'marker in wrong named test',
    ({ data }) => {
      data.testResults[0].assertionResults[0].fullName = 'unrelated case';
    },
  ],
  [
    'setup error carrying marker',
    ({ data }) => {
      data.testResults[0].assertionResults[0].failureMessages = [
        'beforeEach hook FS_CAUSAL_BOUNDARY',
      ];
    },
  ],
  [
    'collection error',
    ({ data }) => {
      data.testResults[0].message = 'Cannot find source module';
    },
  ],
  [
    'timeout',
    ({ child }) => {
      child.timedOut = true;
    },
  ],
  [
    'signal',
    ({ child }) => {
      child.signal = 'SIGKILL';
    },
  ],
  [
    'unjoined worker parent',
    ({ child }) => {
      child.joined = false;
    },
  ],
  [
    'output overflow',
    ({ child }) => {
      child.outputExceeded = true;
    },
  ],
  [
    'hidden unhandled runtime error',
    ({ child }) => {
      child.stderr = 'Unhandled Rejection FS_CAUSAL_BOUNDARY';
    },
  ],
  [
    'skip replacing regression',
    ({ data }) => {
      data.numPendingTests = 1;
      data.testResults[0].assertionResults[0].status = 'pending';
    },
  ],
  [
    'empty inventory',
    ({ data }) => {
      data.numTotalTests = 0;
      data.testResults[0].assertionResults = [];
    },
  ],
  [
    'wrong file inventory',
    ({ data }) => {
      data.testResults[0].name = '/graph/unrelated.mjs';
    },
  ],
])
  test(`refuses false certification: ${name}`, () => {
    const value = sample();
    change(value);
    assert.throws(() =>
      assertPhaseOutcome(value.data, value.child, mechanism, 'mutated', '/graph'),
    );
  });
test('a red restoration cannot be treated as an accepted removal', () => {
  const { data, child } = sample();
  assert.throws(() => assertPhaseOutcome(data, child, mechanism, 'restored', '/graph'));
});
test('shared helper requires named evidence at both actual consumers', () => {
  const { data, child } = sample();
  const control = { ...mechanism, id: 'ancestor-error' };
  data.testResults[0].assertionResults[0].fullName = 'named regression tool';
  assert.throws(
    () => assertPhaseOutcome(data, child, control, 'mutated', '/graph'),
    /both actual consumers/,
  );
});
