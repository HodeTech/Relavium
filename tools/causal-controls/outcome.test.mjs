import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPhaseOutcome } from './outcome.mjs';
import {
  decodeRuntimeReceipt,
  readRuntimeReceipt,
  runtimeReporterPath,
} from './runtime-receipt.mjs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../usage-coverage-controls/source-graph.mjs';
import RuntimeReporter from './runtime-reporter.mjs';
import { mutations as secretsControls } from '../secrets-controls/mutations.mjs';
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
      pid: 123,
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
const receiptIdentity = { runtimeSha256: 'a'.repeat(64), reporterSha256: 'b'.repeat(64) };
function receiptFor(control = mechanism, phase = 'mutated', pid = 123) {
  return {
    version: 1,
    event: 'onTestRunEnd',
    complete: true,
    phase,
    mutationId: control.id,
    ...receiptIdentity,
    reporter: runtimeReporterPath,
    pid,
    unhandledErrors: 0,
    reason: phase === 'mutated' ? 'failed' : 'passed',
  };
}
function checkOutcome(data, child, control, phase, graph) {
  return assertPhaseOutcome(
    data,
    child,
    control,
    phase,
    graph,
    `${JSON.stringify(receiptFor(control, phase, child.pid))}\n`,
    receiptIdentity,
  );
}

test('complete named assertion failure certifies its specific removal', () => {
  const { data, child } = sample();
  assert.doesNotThrow(() => checkOutcome(data, child, mechanism, 'mutated', '/graph'));
});
test('the complete reader workload still requires both native and structural removal witnesses', () => {
  const control = secretsControls.find((entry) => entry.id === 'run-default-secret-reader');
  assert.ok(control);
  const { data, child } = sample();
  data.testResults[0].name = `/graph/${control.files[0]}`;
  data.testResults[0].assertionResults = [
    ...Array.from({ length: 82 }, (_, index) => ({
      fullName: `preserved reader workload ${index}`,
      status: 'passed',
      failureMessages: [],
    })),
    ...[
      'uses the real native default reader once and suppresses an injected gate selector',
      'uses the real structural default reader once and suppresses an injected gate selector',
    ].map((fullName) => ({
      fullName,
      status: 'failed',
      failureMessages: ['AssertionError: SECRETS_CAUSAL_RUN_DEFAULT_READER expected one read'],
    })),
  ];
  data.numTotalTests = 84;
  data.numPassedTests = 82;
  data.numFailedTests = 2;
  const check = (candidate = data, declaration = control) =>
    checkOutcome(candidate, child, declaration, 'mutated', '/graph');
  assert.doesNotThrow(() => check());
  const missing = globalThis.structuredClone(data);
  missing.testResults[0].assertionResults.shift();
  missing.numTotalTests = 83;
  missing.numPassedTests = 81;
  assert.throws(() => check(missing), /Declared workload drift/);
  assert.throws(() => check(data, { ...control, expectedTests: 83 }), /Declared workload drift/);
  const altered = globalThis.structuredClone(data);
  altered.testResults[0].assertionResults[83].fullName = 'unrelated failure';
  assert.throws(() => check(altered), /missing additional named assertion/);
  const passing = globalThis.structuredClone(data);
  passing.testResults[0].assertionResults[83].status = 'passed';
  passing.testResults[0].assertionResults[83].failureMessages = [];
  passing.numPassedTests = 83;
  passing.numFailedTests = 1;
  assert.throws(() => check(passing), /missing additional named assertion/);
});
test('a native assertion prefix retains the same named semantic authority', () => {
  const { data, child } = sample();
  data.testResults[0].assertionResults[0].failureMessages = [
    'AssertionError [ERR_ASSERTION]: FS_CAUSAL_BOUNDARY expected refusal',
  ];
  assert.doesNotThrow(() => checkOutcome(data, child, mechanism, 'mutated', '/graph'));
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
      () => checkOutcome(data, child, mechanism, 'mutated', '/graph'),
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
    assert.throws(() => checkOutcome(value.data, value.child, mechanism, 'mutated', '/graph'));
  });
test('a red restoration cannot be treated as an accepted removal', () => {
  const { data, child } = sample();
  assert.throws(() => checkOutcome(data, child, mechanism, 'restored', '/graph'));
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
    () => checkOutcome(data, child, control, 'mutated', '/graph'),
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
    const check = () => checkOutcome(data, child, control, 'mutated', '/graph');
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
    () => checkOutcome(data, child, control, 'mutated', '/graph'),
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
      () => checkOutcome(data, child, control, 'mutated', '/graph'),
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
  assert.throws(() => checkOutcome(data, child, control, 'mutated', '/graph'), /GC_CONTINUATION/);
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
      checkOutcome(
        data,
        child,
        { ...mechanism, expectedTests: kind === 'duplicate' ? 2 : 1 },
        'mutated',
        '/graph',
      ),
    );
  });

for (const [label, change] of [
  [
    'nonzero runner errors',
    (receipt) => {
      receipt.unhandledErrors = 1;
    },
  ],
  [
    'negative count',
    (receipt) => {
      receipt.unhandledErrors = -1;
    },
  ],
  [
    'fractional count',
    (receipt) => {
      receipt.unhandledErrors = 0.5;
    },
  ],
  [
    'string count',
    (receipt) => {
      receipt.unhandledErrors = '0';
    },
  ],
  [
    'null count',
    (receipt) => {
      receipt.unhandledErrors = null;
    },
  ],
  [
    'missing count',
    (receipt) => {
      delete receipt.unhandledErrors;
    },
  ],
  [
    'incomplete callback',
    (receipt) => {
      receipt.complete = false;
    },
  ],
  [
    'wrong phase',
    (receipt) => {
      receipt.phase = 'fixed';
    },
  ],
  [
    'wrong control',
    (receipt) => {
      receipt.mutationId = 'other';
    },
  ],
  [
    'wrong process',
    (receipt) => {
      receipt.pid = 321;
    },
  ],
  [
    'wrong runtime',
    (receipt) => {
      receipt.runtimeSha256 = 'c'.repeat(64);
    },
  ],
  [
    'wrong source',
    (receipt) => {
      receipt.reporterSha256 = 'c'.repeat(64);
    },
  ],
  [
    'wrong reporter',
    (receipt) => {
      receipt.reporter = 'borrowed.mjs';
    },
  ],
  [
    'wrong callback',
    (receipt) => {
      receipt.event = 'onFinished';
    },
  ],
  [
    'wrong version',
    (receipt) => {
      receipt.version = 2;
    },
  ],
  [
    'interrupted completion',
    (receipt) => {
      receipt.reason = 'interrupted';
    },
  ],
  [
    'nonterminal reason',
    (receipt) => {
      receipt.reason = 'running';
    },
  ],
  [
    'inconsistent reason',
    (receipt) => {
      receipt.reason = 'passed';
    },
  ],
  [
    'additional field',
    (receipt) => {
      receipt.extra = true;
    },
  ],
])
  test(`structured runner receipt refuses ${label}`, () => {
    const { data, child } = sample();
    const receipt = receiptFor();
    change(receipt);
    assert.throws(() =>
      assertPhaseOutcome(
        data,
        child,
        mechanism,
        'mutated',
        '/graph',
        `${JSON.stringify(receipt)}\n`,
        receiptIdentity,
      ),
    );
  });
for (const raw of [
  undefined,
  null,
  '',
  '{',
  '{}',
  'null',
  '[]',
  JSON.stringify(receiptFor()),
  JSON.stringify(receiptFor()).replace(
    '"unhandledErrors":0',
    '"unhandledErrors":1,"unhandledErrors":0',
  ) + '\n',
  JSON.stringify(receiptFor()) + JSON.stringify(receiptFor()),
  ' '.repeat(4097),
])
  test(`structured runner receipt refuses absent/malformed bytes ${String(raw).slice(0, 40)}`, () => {
    const { data, child } = sample();
    assert.throws(() =>
      assertPhaseOutcome(data, child, mechanism, 'mutated', '/graph', raw, receiptIdentity),
    );
  });

test('runner receipt field membership is order-independent and refuses same-size lookalikes', () => {
  const receipt = receiptFor();
  const expected = {
    ...receiptIdentity,
    phase: receipt.phase,
    mutationId: receipt.mutationId,
    pid: receipt.pid,
  };
  const entries = Object.entries(receipt).reverse();
  const encode = (items) => `${JSON.stringify(Object.fromEntries(items))}\n`;
  assert.deepEqual(decodeRuntimeReceipt(encode(entries), expected), receipt);
  for (let index = 0; index < entries.length; index++) {
    const lookalike = entries.map(([key, value], position) => [
      position === index ? `${key}\u200b` : key,
      value,
    ]);
    assert.throws(() => decodeRuntimeReceipt(encode(lookalike), expected), /Runner receipt fields/);
  }
});

test('structured zero-error receipts retain fixed/restored positive authority', () => {
  for (const phase of ['fixed', 'restored']) {
    const { data, child } = sample();
    child.code = 0;
    data.numPassedTests = 1;
    data.numFailedTests = 0;
    data.testResults[0].assertionResults[0].status = 'passed';
    data.testResults[0].assertionResults[0].failureMessages = [];
    assert.doesNotThrow(() => checkOutcome(data, child, mechanism, phase, '/graph'));
    const receipt = receiptFor(mechanism, phase);
    receipt.unhandledErrors = 1;
    assert.throws(
      () =>
        assertPhaseOutcome(
          data,
          child,
          mechanism,
          phase,
          '/graph',
          `${JSON.stringify(receipt)}\n`,
          receiptIdentity,
        ),
      /Unhandled runtime error/,
    );
  }
});

test('runtime receipt reads require bounded physical UTF-8 bytes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'causal-receipt-')));
  try {
    const path = join(root, 'receipt');
    assert.throws(() => readRuntimeReceipt(path));
    const raw = `${JSON.stringify(receiptFor())}\n`;
    writeFileSync(path, raw);
    assert.equal(readRuntimeReceipt(path), raw);
    const redirected = join(root, 'redirected');
    symlinkSync(path, redirected);
    assert.throws(() => readRuntimeReceipt(redirected), /redirected/);
    writeFileSync(path, ' '.repeat(4097));
    assert.throws(() => readRuntimeReceipt(path), /byte bound/);
    writeFileSync(path, new Uint8Array([255]));
    assert.throws(() => readRuntimeReceipt(path), /UTF-8/);
    assert.throws(
      () =>
        decodeRuntimeReceipt(raw, {
          ...receiptIdentity,
          phase: 'mutated',
          mutationId: mechanism.id,
          pid: 321,
        }),
      /wrong process/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const defect of [
  'never-started',
  'duplicate-end',
  'duplicate-start',
  'invalid-errors',
  'invalid-reason',
  'changed-runtime',
  'write-failure',
])
  test(`owned reporter cannot retain a stale success after ${defect}`, () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'causal-reporter-lifecycle-')));
    const previous = process.env.RELAVIUM_USAGE_RUNTIME;
    try {
      const sourceRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
      const source = readFileSync(join(sourceRoot, runtimeReporterPath));
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.stringify({
        sourceRoot,
        files: [{ path: runtimeReporterPath, bytes: source.length, sha256: digest(source) }],
      });
      writeFileSync(manifestPath, manifest);
      const runtimePath = join(directory, 'runtime.json');
      writeFileSync(
        runtimePath,
        JSON.stringify({
          phase: 'mutated',
          mutationId: mechanism.id,
          manifestPath,
          manifestSha256: digest(manifest),
        }),
      );
      process.env.RELAVIUM_USAGE_RUNTIME = runtimePath;
      const reporter = new RuntimeReporter();
      reporter.onInit();
      const receiptPath = join(directory, 'runner-completion.receipt');
      if (defect !== 'never-started') reporter.onTestRunStart();
      if (defect.startsWith('duplicate')) {
        reporter.onTestRunEnd([], [], 'failed');
        assert.equal(JSON.parse(readRuntimeReceipt(receiptPath)).complete, true);
      }
      if (defect === 'changed-runtime') writeFileSync(runtimePath, '{}');
      if (defect === 'write-failure') {
        rmSync(receiptPath);
        mkdirSync(receiptPath);
      }
      assert.throws(() =>
        defect === 'duplicate-start'
          ? reporter.onTestRunStart()
          : reporter.onTestRunEnd(
              [],
              defect === 'invalid-errors' ? undefined : [],
              defect === 'invalid-reason' ? 'running' : 'failed',
            ),
      );
      if (defect === 'write-failure') assert.throws(() => readRuntimeReceipt(receiptPath));
      else assert.deepEqual(JSON.parse(readRuntimeReceipt(receiptPath)), { complete: false });
    } finally {
      if (previous === undefined) delete process.env.RELAVIUM_USAGE_RUNTIME;
      else process.env.RELAVIUM_USAGE_RUNTIME = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
