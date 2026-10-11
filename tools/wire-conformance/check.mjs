/** Reproduce CR-81 lowering controls on isolated byte copies, never on developer files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportAcceptanceEvidence } from '../acceptance-evidence/export.mjs';
import { captureWireProvenance } from './provenance.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const suite = 'src/conformance/canonical-wire.test.ts';
const expectedTests = 24;
const provenance = captureWireProvenance(repository);
const mutations = [
  {
    name: 'anthropic-system',
    path: 'src/adapters/anthropic.ts',
    before: 'body.system = req.system;',
    after: "body.system = 'mutated-system';",
  },
  {
    name: 'openai-tool-continuation-id',
    path: 'src/adapters/openai.ts',
    before: 'tool_call_id: part.toolCallId,',
    after: "tool_call_id: 'mutated-tool-id',",
  },
  {
    name: 'gemini-tool-continuation-signature',
    path: 'src/adapters/gemini.ts',
    before: '...(part.signature === undefined ? {} : { thoughtSignature: part.signature }),',
    after: "...(part.signature === undefined ? {} : { thoughtSignature: 'mutated-signature' }),",
  },
];
mutations.push({
  name: 'complete-evidence-demotion',
  path: 'src/adapters/native-usage.ts',
  before: "kind: 'complete',\n        usage: { ...this.known, inputTokens, outputTokens },",
  after:
    "kind: 'partial',\n        known: { ...this.known, inputTokens, outputTokens },\n        reason: 'missing_fields',",
  evidence: true,
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = new Map(
  mutations.map(({ path }) => [path, readFileSync(join(repository, 'packages/llm', path))]),
);
const scratch = mkdtempSync(join(tmpdir(), 'relavium-wire-mutations-'));
const workspace = join(scratch, 'packages/llm');
const results = [];
let expectedCaseIds;

function run(label, shouldPass, mutation) {
  const report = join(scratch, `${label}.json`);
  const child = spawnSync(
    process.execPath,
    [vitest, 'run', suite, '--reporter=json', '--outputFile', report, '--passWithNoTests=false'],
    { cwd: workspace, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(child.error, undefined, `${label}: runner failed`);
  assert.equal(child.signal, null, `${label}: runner did not settle`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(data.numTotalTests, expectedTests, `${label}: canonical matrix changed`);
  assert.equal(data.numPendingTests, 0, `${label}: skipped canonical case`);
  assert.equal(data.numTodoTests, 0, `${label}: unfinished canonical case`);
  const cases = data.testResults.flatMap((file) => file.assertionResults);
  assert.equal(cases.length, expectedTests, `${label}: incomplete case inventory`);
  assert.ok(
    cases.every((test) => test.status === 'passed' || test.status === 'failed'),
    `${label}: unfinished case`,
  );
  const caseIds = cases.map((test) => test.fullName).sort();
  assert.equal(new Set(caseIds).size, expectedTests, `${label}: duplicated canonical case`);
  if (expectedCaseIds === undefined) expectedCaseIds = caseIds;
  else assert.deepEqual(caseIds, expectedCaseIds, `${label}: canonical case identities changed`);
  const failed = data.testResults.flatMap((file) =>
    file.assertionResults.filter((test) => test.status === 'failed'),
  );
  if (shouldPass) {
    assert.equal(child.status, 0, `${label}: canonical matrix failed`);
    assert.equal(data.numPassedTests, expectedTests, `${label}: incomplete success`);
    assert.equal(failed.length, 0, `${label}: failed canonical case`);
  } else {
    assert.equal(child.status, 1, `${label}: mutation was not rejected by tests`);
    assert.ok(failed.length > 0, `${label}: suite failure is not a lowering regression`);
    assert.ok(
      failed.some((test) =>
        test.failureMessages.some((message) =>
          message.includes(mutation.evidence ? 'WIRE_CAUSAL_USAGE_EVIDENCE' : 'request_mismatch'),
        ),
      ),
      `${label}: mutation failed without its declared strict assertion`,
    );
  }
  if (!shouldPass && mutation.evidence) {
    assert.equal(failed.length, expectedTests, 'Evidence demotion must fail every canonical case');
    assert.ok(
      failed.every((test) =>
        test.failureMessages.some(
          (message) =>
            message.includes('WIRE_CAUSAL_USAGE_EVIDENCE') &&
            message.includes('partial') &&
            message.includes('complete'),
        ),
      ),
      'Evidence demotion lost the literal arm diagnostic',
    );
  }
  return {
    tests: data.numTotalTests,
    passed: data.numPassedTests,
    failed: failed.map((test) => test.fullName),
  };
}

let report = { complete: false, provenance, mutations: results };
let primaryFailure;
try {
  mkdirSync(workspace, { recursive: true });
  cpSync(join(repository, 'packages/llm/src'), join(workspace, 'src'), { recursive: true });
  for (const name of [
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'tsconfig.seam.json',
  ]) {
    cpSync(join(repository, 'packages/llm', name), join(workspace, name));
  }
  for (const name of ['vitest.config.ts', 'tsconfig.base.json']) {
    cpSync(join(repository, name), join(scratch, name));
  }
  // Installed dependencies are read from the same checkout; neither source nor dependencies are changed.
  const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(join(repository, 'node_modules'), join(scratch, 'node_modules'), linkKind);
  symlinkSync(
    join(repository, 'packages/llm/node_modules'),
    join(workspace, 'node_modules'),
    linkKind,
  );
  const baseline = run('baseline', true);
  for (const mutation of mutations) {
    const original = sources.get(mutation.path);
    assert.ok(original !== undefined, 'missing source snapshot');
    const target = join(workspace, mutation.path);
    assert.deepEqual(readFileSync(target), original, 'copy differs before mutation');
    const text = original.toString('utf8');
    assert.equal(text.split(mutation.before).length, 2, `${mutation.name}: source anchor drift`);
    let rejected;
    try {
      writeFileSync(target, text.replace(mutation.before, mutation.after));
      rejected = run(mutation.name, false, mutation);
    } finally {
      writeFileSync(target, original);
      assert.deepEqual(readFileSync(target), original, 'source restoration is not byte-exact');
    }
    const restored = run(`${mutation.name}-restored`, true);
    results.push({
      name: mutation.name,
      path: mutation.path,
      sourceSha256: digest(original),
      rejected,
      restored,
    });
  }
  for (const [path, original] of sources) {
    assert.deepEqual(
      readFileSync(join(repository, 'packages/llm', path)),
      original,
      'developer source changed during validation',
    );
  }
  assert.deepEqual(
    captureWireProvenance(repository),
    provenance,
    'Wire source/dependency provenance changed',
  );
  report = {
    complete: true,
    provenance,
    baseline,
    mutations: results,
    isolated: true,
    developerSourcesUnchanged: true,
  };
  writeFileSync(join(scratch, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  primaryFailure = { error };
  report.failure = { name: error.name, message: error.message };
} finally {
  try {
    exportAcceptanceEvidence({ repository, scratch, kind: 'wire', report });
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = { error };
    else console.error('Acceptance evidence export failed after the primary wire-control failure.');
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = { error };
    else console.error('Scratch cleanup failed after the primary wire-control failure.');
  }
}
if (primaryFailure !== undefined) throw primaryFailure.error;
