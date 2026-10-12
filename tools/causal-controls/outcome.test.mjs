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
test('a native assertion prefix retains the same named semantic authority', () => {
  const { data, child } = sample();
  data.testResults[0].assertionResults[0].failureMessages = [
    'AssertionError [ERR_ASSERTION]: FS_CAUSAL_BOUNDARY expected refusal',
  ];
  assert.doesNotThrow(() => assertPhaseOutcome(data, child, mechanism, 'mutated', '/graph'));
});
for (const messages of [
  ['Error: FS_CAUSAL_BOUNDARY'],
  ['TypeError: FS_CAUSAL_BOUNDARY'],
  ['Error: unrelated\n    AssertionError: FS_CAUSAL_BOUNDARY'],
  ['AssertionError: unrelated', 'Error: FS_CAUSAL_BOUNDARY'],
])
  test(`marker-bearing runtime errors cannot certify removal: ${messages.join(' | ')}`, () => {
    const { data, child } = sample();
    data.testResults[0].assertionResults[0].failureMessages = messages;
    assert.throws(
      () => assertPhaseOutcome(data, child, mechanism, 'mutated', '/graph'),
      /missing declared named assertion/,
    );
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
    assert.equal(typeof change, 'function');
    if (typeof change !== 'function') throw new Error('Invalid refusal fixture');
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
  const control = {
    ...mechanism,
    id: 'ancestor-error',
    witnesses: ['tool', 'save_to'].map((port) => ({
      target: `named regression ${port}`,
      marker: mechanism.marker,
    })),
  };
  data.testResults[0].assertionResults[0].fullName = 'named regression tool';
  assert.throws(
    () => assertPhaseOutcome(data, child, control, 'mutated', '/graph'),
    /missing additional named assertion/,
  );
});

for (const additionalFails of [true, false])
  test(`additional caller witness must fail independently: ${additionalFails}`, () => {
    const { data, child } = sample();
    const control = {
      ...mechanism,
      expectedTests: 2,
      witnesses: [{ target: 'actual caller', marker: 'FS_CAUSAL_CALLER' }],
    };
    data.numTotalTests = 2;
    data.numFailedTests = additionalFails ? 2 : 1;
    data.numPassedTests = additionalFails ? 0 : 1;
    data.testResults[0].assertionResults.push({
      fullName: 'actual caller',
      status: additionalFails ? 'failed' : 'passed',
      failureMessages: additionalFails ? ['AssertionError: FS_CAUSAL_CALLER expected success'] : [],
    });
    const check = () => assertPhaseOutcome(data, child, control, 'mutated', '/graph');
    if (additionalFails) assert.doesNotThrow(check);
    else assert.throws(check, /missing additional named assertion FS_CAUSAL_CALLER/);
  });

test('an additional witness needs its own assertion rather than a marker-bearing Error', () => {
  const { data, child } = sample();
  const control = {
    ...mechanism,
    expectedTests: 2,
    witnesses: [{ target: 'actual caller', marker: 'FS_CAUSAL_CALLER' }],
  };
  data.numTotalTests = 2;
  data.numFailedTests = 2;
  data.testResults[0].assertionResults.push({
    fullName: 'actual caller',
    status: 'failed',
    failureMessages: ['Error: FS_CAUSAL_CALLER'],
  });
  assert.throws(
    () => assertPhaseOutcome(data, child, control, 'mutated', '/graph'),
    /missing additional named assertion FS_CAUSAL_CALLER/,
  );
});

for (const port of ['tool', 'save_to'])
  test(`ancestor evidence at only ${port} cannot certify the shared helper`, () => {
    const { data, child } = sample();
    const control = {
      ...mechanism,
      witnesses: ['tool', 'save_to'].map((name) => ({
        target: `named regression ${name}`,
        marker: mechanism.marker,
      })),
    };
    data.testResults[0].assertionResults[0].fullName = `named regression ${port}`;
    assert.throws(
      () => assertPhaseOutcome(data, child, control, 'mutated', '/graph'),
      /additional named assertion/,
    );
  });
test('real delete declaration cannot certify a store red without GC continuation', async () => {
  const { mutations } = await import('../fs-policy-controls/mutations.mjs');
  const deletion = mutations.find((entry) => entry.id === 'cas-delete-idempotent');
  assert.deepEqual(deletion.witnesses, [
    {
      target: 'both cooperating grace collectors continue to the orphan phase',
      marker: 'FS_CAUSAL_CAS_DELETE_GC_CONTINUATION',
    },
  ]);
  const { data, child } = sample();
  const control = { ...mechanism, witnesses: deletion.witnesses };
  assert.throws(
    () => assertPhaseOutcome(data, child, control, 'mutated', '/graph'),
    /GC_CONTINUATION/,
  );
});
for (const kind of ['todo', 'duplicate', 'spawn-error'])
  test(`additional incomplete evidence refusal: ${kind}`, () => {
    const { data, child } = sample();
    if (kind === 'todo') {
      data.numTodoTests = 1;
      data.testResults[0].assertionResults[0].status = 'todo';
    }
    if (kind === 'duplicate') {
      data.testResults[0].assertionResults.push(data.testResults[0].assertionResults[0]);
      data.numTotalTests = 2;
    }
    if (kind === 'spawn-error') child.spawnError = { message: 'spawn refused' };
    assert.throws(() =>
      assertPhaseOutcome(
        data,
        child,
        { ...mechanism, expectedTests: kind === 'duplicate' ? 2 : 1 },
        'mutated',
        '/graph',
      ),
    );
  });
